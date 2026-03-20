import { defineTool, param } from "./types.js";
import { extractGoogleConfig, resetGoogleToken, type GoogleConfig } from "./_google-auth.js";
import { getUser } from "../users.js";
import {
  listEvents,
  createEvent,
  createCalendar,
  updateEvent,
  deleteEvent,
  formatEventTime,
} from "./google-calendar.js";
import { getCachedSupabaseClient, ensureUserProfile, getCalendarId, setCalendarId } from "../supabase.js";
import { getAllUsers } from "../users.js";

// ============================================================
// Per-user calendars — each user gets their own Google Calendar.
// Events are also tagged with user info for heartbeat sync.
// ============================================================

// In-memory cache: discordUserId → Promise<calendarId>
// Caching the promise itself prevents race conditions where
// concurrent calls both create a new calendar.
const _calendarCache = new Map<string, Promise<string>>();

/** Verify a calendar ID is still valid by making a lightweight API call. */
async function verifyCalendar(config: GoogleConfig, calendarId: string): Promise<boolean> {
  try {
    const events = await listEvents(config, calendarId, { maxResults: 1, daysAhead: 1 });
    // If it didn't throw, the calendar exists (even if empty)
    void events;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a user's personal Google Calendar ID.
 * Creates the calendar on first use; caches in memory + Supabase.
 */
export async function resolveUserCalendar(
  config: GoogleConfig,
  discordUserId: string,
  username?: string,
): Promise<string> {
  const cached = _calendarCache.get(discordUserId);
  if (cached) return cached;

  const promise = _resolveUserCalendarInner(config, discordUserId, username);
  _calendarCache.set(discordUserId, promise);

  // Evict on failure so next call can retry
  promise.catch(() => _calendarCache.delete(discordUserId));

  return promise;
}

async function _resolveUserCalendarInner(
  config: GoogleConfig,
  discordUserId: string,
  username?: string,
): Promise<string> {
  const sb = getCachedSupabaseClient();

  // 1. Check Supabase for stored calendar ID
  if (sb) {
    await ensureUserProfile(sb, discordUserId);
    const stored = await getCalendarId(sb, discordUserId);
    if (stored) {
      // Verify it still exists
      const valid = await verifyCalendar(config, stored);
      if (valid) return stored;
      console.warn(`Calendar: stored ID ${stored} for user ${discordUserId} is invalid, creating new`);
    }
  }

  // 2. Create a new secondary calendar for this user
  const displayName = username ?? getUser(discordUserId)?.username ?? discordUserId;
  const calendarTitle = `${displayName}'s Calendar`;
  const calendarId = await createCalendar(config, calendarTitle);
  console.log(`Calendar: created "${calendarTitle}" (${calendarId}) for user ${discordUserId}`);

  // 3. Persist to Supabase
  if (sb) {
    await setCalendarId(sb, discordUserId, calendarId);
  }

  return calendarId;
}

/** Build a description that tags the Discord user for attribution. */
function tagDescription(userId: string, description?: string): string {
  const user = getUser(userId);
  const tag = `[user:${userId}${user ? `:${user.username}` : ""}]`;
  if (!description) return tag;
  return `${description}\n${tag}`;
}

/** Extract the user tag from an event description. */
function extractUserTag(description?: string): { userId?: string; username?: string } {
  if (!description) return {};
  const match = description.match(/\[user:(\d+)(?::([^\]]+))?\]/);
  if (!match) return {};
  return { userId: match[1], username: match[2] };
}

/** Check if an event belongs to a specific user. */
function isUserEvent(description: string | undefined, userId: string): boolean {
  const tag = extractUserTag(description);
  return tag.userId === userId;
}

/** Strip the user tag from description for display. */
function cleanDescription(description?: string): string | undefined {
  if (!description) return undefined;
  const cleaned = description.replace(/\n?\[user:\d+(?::[^\]]+)?\]/, "").trim();
  return cleaned || undefined;
}

// Export for use by heartbeat and scoring sync
export { extractUserTag, isUserEvent };

// ============================================================
// LLM Tool definition
// ============================================================

export default defineTool({
  name: "calendar",
  description:
    "Manage calendar events. Add tasks, appointments, reminders, and events. " +
    "Actions: list, create, update, delete. " +
    "Supports full date and time scheduling. " +
    "Always use the date tool first to resolve natural language dates/times.",

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  params: {
    action: param.enum(
      "Action to perform.",
      ["list", "create", "update", "delete"] as const,
      { required: true },
    ),
    summary: param.string("Event title. Required for create."),
    description: param.string("Event description. Optional for create and update."),
    location: param.string("Event location. Optional for create and update."),
    startDateTime: param.string(
      "Start time in ISO 8601 format in the user's local timezone (e.g. 2025-03-15T14:00:00). " +
      "Do NOT append Z or a UTC offset. Required for create.",
    ),
    endDateTime: param.string(
      "End time in ISO 8601 format in the user's local timezone (e.g. 2025-03-15T15:00:00). " +
      "Do NOT append Z or a UTC offset. Required for create.",
    ),
    eventId: param.string("Event ID. Required for update and delete."),
    maxResults: param.number("Max events to return for list (1-50, default 10).", { minimum: 1, maximum: 50 }),
    daysAhead: param.number("Days ahead to search for list (1-365, default 14).", { minimum: 1, maximum: 365 }),
  },

  handler: async (
    { action, summary, description, location, startDateTime, endDateTime, eventId, maxResults, daysAhead },
    { toolConfig, userId },
  ) => {
    const config = extractGoogleConfig(toolConfig);

    try {
      switch (action) {
        case "list": {
          const days = daysAhead ?? 14;
          type EventWithUser = { event: import("./google-calendar.js").CalendarEvent; owner?: string };
          let merged: EventWithUser[] = [];

          if (userId) {
            // User-scoped: single calendar
            const calendarId = await resolveUserCalendar(config, userId);
            const events = await listEvents(config, calendarId, {
              maxResults: maxResults ?? 25,
              daysAhead: days,
            });
            merged = events.map(e => ({ event: e }));
          } else {
            // No user context (cron): aggregate all users' calendars
            const users = getAllUsers();
            const userIds = Object.keys(users);
            const results = await Promise.allSettled(
              userIds.map(async (uid) => {
                const calId = await resolveUserCalendar(config, uid);
                const events = await listEvents(config, calId, { maxResults: 20, daysAhead: days });
                const name = users[uid]?.username ?? uid;
                return events.map(e => ({ event: e, owner: name }));
              }),
            );
            for (const r of results) {
              if (r.status === "fulfilled") merged.push(...r.value);
            }
            // Sort by start time
            merged.sort((a, b) => {
              const aStart = a.event.start.dateTime ?? a.event.start.date ?? "";
              const bStart = b.event.start.dateTime ?? b.event.start.date ?? "";
              return aStart > bStart ? 1 : aStart < bStart ? -1 : 0;
            });
            merged = merged.slice(0, maxResults ?? 25);
          }

          if (merged.length === 0) {
            return { text: `No upcoming events in the next ${days} days.`, data: { action: "list", count: 0, events: [] } };
          }

          const lines = merged.map((m, i) => {
            const e = m.event;
            let line = `${i + 1}. ${e.summary ?? "(no title)"}`;
            if (m.owner) line += ` (${m.owner})`;
            line += `\n   When: ${formatEventTime(e.start)} → ${formatEventTime(e.end)}`;
            if (e.location) line += `\n   Where: ${e.location}`;
            const desc = cleanDescription(e.description);
            if (desc) line += `\n   Notes: ${desc.slice(0, 100)}`;
            line += `\n   ID: ${e.id}`;
            return line;
          });

          return {
            text: `Events (${merged.length}, next ${days} days):\n\n${lines.join("\n\n")}`,
            data: {
              action: "list",
              count: merged.length,
              events: merged.map(m => ({
                id: m.event.id,
                summary: m.event.summary ?? null,
                description: cleanDescription(m.event.description) ?? null,
                location: m.event.location ?? null,
                start: m.event.start,
                end: m.event.end,
                htmlLink: m.event.htmlLink ?? null,
                owner: m.owner ?? null,
              })),
            },
          };
        }

        case "create": {
          if (!userId) return "Error: Calendar create requires a user context. Run this in a Discord channel or DM.";
          if (!summary) return "Error: summary is required for create.";
          if (!startDateTime) return "Error: startDateTime is required for create.";
          if (!endDateTime) return "Error: endDateTime is required for create.";

          const createCalId = await resolveUserCalendar(config, userId);
          const created = await createEvent(config, createCalId, {
            summary: summary as string,
            description: tagDescription(userId, description as string | undefined),
            location: location as string | undefined,
            startDateTime: startDateTime as string,
            endDateTime: endDateTime as string,
          });

          let text = `Event created: ${created.summary}`;
          text += `\nWhen: ${formatEventTime(created.start)} → ${formatEventTime(created.end)}`;
          if (created.location) text += `\nWhere: ${created.location}`;
          text += `\nID: ${created.id}`;

          return {
            text,
            data: { action: "create", event: { id: created.id, summary: created.summary ?? null, start: created.start, end: created.end } },
          };
        }

        case "update": {
          if (!userId) return "Error: Calendar update requires a user context. Run this in a Discord channel or DM.";
          if (!eventId) return "Error: eventId is required for update.";

          const updateCalId = await resolveUserCalendar(config, userId);
          const updated = await updateEvent(config, updateCalId, eventId as string, {
            summary: summary as string | undefined,
            description: description ? tagDescription(userId, description as string) : undefined,
            location: location as string | undefined,
            startDateTime: startDateTime as string | undefined,
            endDateTime: endDateTime as string | undefined,
          });
          if (!updated) return `Error: event not found or no fields to update (ID: ${eventId}).`;

          let text = `Event updated: ${updated.summary}`;
          text += `\nWhen: ${formatEventTime(updated.start)} → ${formatEventTime(updated.end)}`;
          if (updated.location) text += `\nWhere: ${updated.location}`;
          text += `\nID: ${updated.id}`;

          return {
            text,
            data: { action: "update", event: { id: updated.id, summary: updated.summary ?? null, start: updated.start, end: updated.end } },
          };
        }

        case "delete": {
          if (!userId) return "Error: Calendar delete requires a user context. Run this in a Discord channel or DM.";
          if (!eventId) return "Error: eventId is required for delete.";
          const deleteCalId = await resolveUserCalendar(config, userId);
          const deleted = await deleteEvent(config, deleteCalId, eventId as string);
          if (!deleted) return `Error: event not found (ID: ${eventId}).`;
          return {
            text: `Event deleted (ID: ${eventId}).`,
            data: { action: "delete", eventId },
          };
        }

        default:
          return `Error: unknown action "${action}".`;
      }
    } catch (err) {
      resetGoogleToken();
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

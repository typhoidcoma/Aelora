import { defineTool, param } from "./types.js";
import { extractGoogleConfig, resetGoogleToken, type GoogleConfig } from "./_google-auth.js";
import { getCachedSupabaseClient, ensureUserProfile, getCalendarId, setCalendarId } from "../supabase.js";
import { getUser } from "../users.js";
import {
  createCalendar,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  formatEventTime,
  type CalendarEvent,
} from "./google-calendar.js";

// ============================================================
// Per-user calendar management
// ============================================================

// In-memory cache: discordUserId → Promise<calendarId>
const _calendarCache = new Map<string, Promise<string>>();

/**
 * Resolve a user's Google Calendar ID.
 * If the user doesn't have one yet, creates a secondary calendar and stores the mapping.
 * Cached per-process to prevent duplicate calendar creation.
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

  // On failure, evict so next call can retry
  promise.catch(() => _calendarCache.delete(discordUserId));

  return promise;
}

async function _resolveUserCalendarInner(
  config: GoogleConfig,
  discordUserId: string,
  username?: string,
): Promise<string> {
  const sb = getCachedSupabaseClient();

  if (sb) {
    await ensureUserProfile(sb, discordUserId);
    const existing = await getCalendarId(sb, discordUserId);
    if (existing) return existing;
  }

  // Create a new secondary calendar for this user
  const displayName = username ?? getUser(discordUserId)?.username ?? discordUserId;
  const calTitle = `${displayName}'s Calendar`;
  const calId = await createCalendar(config, calTitle);
  console.log(`Calendar: created "${calTitle}" (${calId}) for user ${discordUserId}`);

  if (sb) {
    await setCalendarId(sb, discordUserId, calId);
  }

  return calId;
}

// ============================================================
// LLM Tool definition
// ============================================================

export default defineTool({
  name: "calendar",
  description:
    "Manage personal calendar events. Each user has their own calendar. " +
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

    if (!userId) {
      return "Error: Calendar requires a user context. Run this in a Discord channel or DM.";
    }

    try {
      const calendarId = await resolveUserCalendar(config, userId);

      switch (action) {
        case "list": {
          const events = await listEvents(config, calendarId, {
            maxResults: maxResults ?? 10,
            daysAhead: daysAhead ?? 14,
          });
          const days = daysAhead ?? 14;

          if (events.length === 0) {
            return { text: `No upcoming events in the next ${days} days.`, data: { action: "list", count: 0, events: [] } };
          }

          const lines = events.map((e, i) => {
            let line = `${i + 1}. ${e.summary ?? "(no title)"}`;
            line += `\n   When: ${formatEventTime(e.start)} → ${formatEventTime(e.end)}`;
            if (e.location) line += `\n   Where: ${e.location}`;
            if (e.description) line += `\n   Notes: ${e.description.slice(0, 100)}`;
            line += `\n   ID: ${e.id}`;
            return line;
          });

          return {
            text: `Events (${events.length}, next ${days} days):\n\n${lines.join("\n\n")}`,
            data: {
              action: "list",
              count: events.length,
              events: events.map(e => ({
                id: e.id,
                summary: e.summary ?? null,
                description: e.description ?? null,
                location: e.location ?? null,
                start: e.start,
                end: e.end,
                htmlLink: e.htmlLink ?? null,
              })),
            },
          };
        }

        case "create": {
          if (!summary) return "Error: summary is required for create.";
          if (!startDateTime) return "Error: startDateTime is required for create.";
          if (!endDateTime) return "Error: endDateTime is required for create.";

          const created = await createEvent(config, calendarId, {
            summary: summary as string,
            description: description as string | undefined,
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
          if (!eventId) return "Error: eventId is required for update.";

          const updated = await updateEvent(config, calendarId, eventId as string, {
            summary: summary as string | undefined,
            description: description as string | undefined,
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
          if (!eventId) return "Error: eventId is required for delete.";
          const deleted = await deleteEvent(config, calendarId, eventId as string);
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

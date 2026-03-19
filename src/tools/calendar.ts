import { defineTool, param } from "./types.js";
import { extractGoogleConfig, resetGoogleToken, type GoogleConfig } from "./_google-auth.js";
import { getUser } from "../users.js";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  formatEventTime,
} from "./google-calendar.js";

// ============================================================
// Shared calendar — all users share the primary calendar.
// Events are tagged with the user's name in the description.
// ============================================================

const CALENDAR_ID = "primary";

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
export { CALENDAR_ID, extractUserTag, isUserEvent };

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

    if (!userId) {
      return "Error: Calendar requires a user context. Run this in a Discord channel or DM.";
    }

    try {
      switch (action) {
        case "list": {
          const allEvents = await listEvents(config, CALENDAR_ID, {
            maxResults: maxResults ?? 25,
            daysAhead: daysAhead ?? 14,
          });

          // Filter to only this user's events
          const events = allEvents.filter(e => isUserEvent(e.description, userId));
          const days = daysAhead ?? 14;

          if (events.length === 0) {
            return { text: `No upcoming events in the next ${days} days.`, data: { action: "list", count: 0, events: [] } };
          }

          const lines = events.map((e, i) => {
            let line = `${i + 1}. ${e.summary ?? "(no title)"}`;
            line += `\n   When: ${formatEventTime(e.start)} → ${formatEventTime(e.end)}`;
            if (e.location) line += `\n   Where: ${e.location}`;
            const desc = cleanDescription(e.description);
            if (desc) line += `\n   Notes: ${desc.slice(0, 100)}`;
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
                description: cleanDescription(e.description) ?? null,
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

          const created = await createEvent(config, CALENDAR_ID, {
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
          if (!eventId) return "Error: eventId is required for update.";

          const updated = await updateEvent(config, CALENDAR_ID, eventId as string, {
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
          if (!eventId) return "Error: eventId is required for delete.";
          const deleted = await deleteEvent(config, CALENDAR_ID, eventId as string);
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

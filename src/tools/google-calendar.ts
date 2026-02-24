import { defineTool, param } from "./types.js";
import { googleFetch, extractGoogleConfig, resetGoogleToken } from "./_google-auth.js";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

// ── Helpers ──────────────────────────────────────────────────

function getTimezone(): string {
  return process.env.TZ || "UTC";
}

/** Format a Google Calendar event datetime for display. */
function formatEventTime(dt: { dateTime?: string; date?: string }): string {
  if (dt.date) return dt.date; // all-day event
  if (!dt.dateTime) return "(unknown)";
  try {
    return new Date(dt.dateTime).toLocaleString("en-US", {
      timeZone: getTimezone(),
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return dt.dateTime;
  }
}

type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  htmlLink?: string;
  status?: string;
};

// ── Tool ─────────────────────────────────────────────────────

export default defineTool({
  name: "google_calendar",
  description:
    "Manage events on the user's Google Calendar. List upcoming events, create, update, or delete events, and list available calendars. This is separate from the local CalDAV calendar.",

  params: {
    action: param.enum(
      "The action to perform.",
      ["list", "create", "update", "delete", "calendars"] as const,
      { required: true },
    ),
    summary: param.string("Event title. Required for create."),
    description: param.string("Event description."),
    location: param.string("Event location."),
    startDateTime: param.string(
      "Start time in ISO 8601 format in the user's local timezone. Do NOT append Z or a UTC offset. Required for create.",
    ),
    endDateTime: param.string(
      "End time in ISO 8601 format in the user's local timezone. Do NOT append Z or a UTC offset. Required for create.",
    ),
    eventId: param.string("Google Calendar event ID. Required for update and delete."),
    calendarId: param.string("Calendar ID (default: 'primary'). Use 'calendars' action to list available calendars."),
    maxResults: param.number("Max events to return for list (1-50, default 10).", { minimum: 1, maximum: 50 }),
    daysAhead: param.number("Days ahead to search for list (1-365, default 14).", { minimum: 1, maximum: 365 }),
  },

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  handler: async (
    { action, summary, description, location, startDateTime, endDateTime, eventId, calendarId, maxResults, daysAhead },
    { toolConfig },
  ) => {
    const config = extractGoogleConfig(toolConfig);
    const cal = calendarId || "primary";
    const tz = getTimezone();

    try {
      switch (action) {
        // ── List ─────────────────────────────────────────────
        case "list": {
          const max = maxResults ?? 10;
          const days = daysAhead ?? 14;

          const now = new Date();
          const future = new Date(now.getTime() + days * 86_400_000);

          const params = new URLSearchParams({
            timeMin: now.toISOString(),
            timeMax: future.toISOString(),
            maxResults: String(max),
            singleEvents: "true",
            orderBy: "startTime",
            timeZone: tz,
          });

          const res = await googleFetch(`${CALENDAR_BASE}/calendars/${encodeURIComponent(cal)}/events?${params}`, config);
          if (!res.ok) return `Error: failed to fetch events (${res.status}).`;

          const data = (await res.json()) as { items?: CalendarEvent[]; summary?: string };
          const events = data.items ?? [];

          if (events.length === 0) {
            return `No upcoming events in the next ${days} days.`;
          }

          let result = `Upcoming events (next ${days} days):\n`;
          for (let i = 0; i < events.length; i++) {
            const e = events[i];
            result += `\n${i + 1}. ${e.summary ?? "(no title)"}\n`;
            result += `   When: ${formatEventTime(e.start)} → ${formatEventTime(e.end)}\n`;
            if (e.location) result += `   Where: ${e.location}\n`;
            if (e.description) result += `   Notes: ${e.description.slice(0, 150)}\n`;
            result += `   ID: ${e.id}\n`;
          }

          return result;
        }

        // ── Create ───────────────────────────────────────────
        case "create": {
          if (!summary) return "Error: summary is required for create.";
          if (!startDateTime) return "Error: startDateTime is required for create.";
          if (!endDateTime) return "Error: endDateTime is required for create.";

          const event: Record<string, unknown> = {
            summary,
            start: { dateTime: startDateTime, timeZone: tz },
            end: { dateTime: endDateTime, timeZone: tz },
          };
          if (description) event.description = description;
          if (location) event.location = location;

          const res = await googleFetch(
            `${CALENDAR_BASE}/calendars/${encodeURIComponent(cal)}/events`,
            config,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(event),
            },
          );

          if (!res.ok) {
            const err = await res.text();
            return `Error: failed to create event (${res.status}): ${err.slice(0, 200)}`;
          }

          const created = (await res.json()) as CalendarEvent;
          let result = `Event created: ${created.summary}\n`;
          result += `When: ${formatEventTime(created.start)} → ${formatEventTime(created.end)}\n`;
          if (created.location) result += `Where: ${created.location}\n`;
          result += `ID: ${created.id}\n`;
          if (created.htmlLink) result += `Link: ${created.htmlLink}`;

          return result;
        }

        // ── Update ───────────────────────────────────────────
        case "update": {
          if (!eventId) return "Error: eventId is required for update.";

          const patch: Record<string, unknown> = {};
          if (summary) patch.summary = summary;
          if (description) patch.description = description;
          if (location) patch.location = location;
          if (startDateTime) patch.start = { dateTime: startDateTime, timeZone: tz };
          if (endDateTime) patch.end = { dateTime: endDateTime, timeZone: tz };

          if (Object.keys(patch).length === 0) {
            return "Error: provide at least one field to update (summary, description, location, startDateTime, endDateTime).";
          }

          const res = await googleFetch(
            `${CALENDAR_BASE}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`,
            config,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            },
          );

          if (!res.ok) {
            if (res.status === 404) return `Error: event not found (ID: ${eventId}).`;
            return `Error: failed to update event (${res.status}).`;
          }

          const updated = (await res.json()) as CalendarEvent;
          let result = `Event updated: ${updated.summary}\n`;
          result += `When: ${formatEventTime(updated.start)} → ${formatEventTime(updated.end)}\n`;
          if (updated.location) result += `Where: ${updated.location}\n`;
          result += `ID: ${updated.id}`;

          return result;
        }

        // ── Delete ───────────────────────────────────────────
        case "delete": {
          if (!eventId) return "Error: eventId is required for delete.";

          const res = await googleFetch(
            `${CALENDAR_BASE}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`,
            config,
            { method: "DELETE" },
          );

          if (!res.ok) {
            if (res.status === 404) return `Error: event not found (ID: ${eventId}).`;
            return `Error: failed to delete event (${res.status}).`;
          }

          return `Event deleted (ID: ${eventId}).`;
        }

        // ── Calendars ────────────────────────────────────────
        case "calendars": {
          const res = await googleFetch(`${CALENDAR_BASE}/users/me/calendarList`, config);
          if (!res.ok) return `Error: failed to fetch calendars (${res.status}).`;

          const data = (await res.json()) as {
            items: {
              id: string;
              summary: string;
              primary?: boolean;
              accessRole: string;
              backgroundColor?: string;
            }[];
          };

          let result = "Available Google Calendars:\n";
          for (const c of data.items) {
            const primary = c.primary ? " (primary)" : "";
            result += `\n  ${c.summary}${primary}\n`;
            result += `  ID: ${c.id}\n`;
            result += `  Access: ${c.accessRole}\n`;
          }

          return result;
        }

        default:
          return `Error: unknown action "${action}". Use: list, create, update, delete, calendars.`;
      }
    } catch (err) {
      resetGoogleToken();
      return `Error: Google Calendar operation failed: ${String(err)}`;
    }
  },
});

import { defineTool, param } from "./types.js";
import { googleFetch, extractGoogleConfig, resetGoogleToken, type GoogleConfig } from "./_google-auth.js";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

// ── Types ───────────────────────────────────────────────────

export type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  htmlLink?: string;
  status?: string;
};

// ── Helpers ──────────────────────────────────────────────────

function getTimezone(): string {
  return process.env.TZ || "UTC";
}

/** Format a Google Calendar event datetime for display. */
export function formatEventTime(dt: { dateTime?: string; date?: string }): string {
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

// ── Exported CRUD functions ─────────────────────────────────

/** Create a new secondary Google Calendar and return its ID. */
export async function createCalendar(
  config: GoogleConfig,
  summary: string,
): Promise<string> {
  const res = await googleFetch(
    `${CALENDAR_BASE}/calendars`,
    config,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary, timeZone: getTimezone() }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API error creating calendar (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function listEvents(
  config: GoogleConfig,
  calendarId: string,
  opts: { maxResults?: number; daysAhead?: number } = {},
): Promise<CalendarEvent[]> {
  const max = opts.maxResults ?? 10;
  const days = opts.daysAhead ?? 14;
  const tz = getTimezone();

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

  const res = await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    config,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API error (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { items?: CalendarEvent[] };
  return data.items ?? [];
}

export async function createEvent(
  config: GoogleConfig,
  calendarId: string,
  opts: {
    summary: string;
    description?: string;
    location?: string;
    startDateTime: string;
    endDateTime: string;
  },
): Promise<CalendarEvent> {
  const tz = getTimezone();
  const event: Record<string, unknown> = {
    summary: opts.summary,
    start: { dateTime: opts.startDateTime, timeZone: tz },
    end: { dateTime: opts.endDateTime, timeZone: tz },
  };
  if (opts.description) event.description = opts.description;
  if (opts.location) event.location = opts.location;

  const res = await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    config,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API error (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as CalendarEvent;
}

export async function updateEvent(
  config: GoogleConfig,
  calendarId: string,
  eventId: string,
  updates: {
    summary?: string;
    description?: string;
    location?: string;
    startDateTime?: string;
    endDateTime?: string;
  },
): Promise<CalendarEvent | null> {
  const tz = getTimezone();
  const patch: Record<string, unknown> = {};
  if (updates.summary) patch.summary = updates.summary;
  if (updates.description) patch.description = updates.description;
  if (updates.location) patch.location = updates.location;
  if (updates.startDateTime) patch.start = { dateTime: updates.startDateTime, timeZone: tz };
  if (updates.endDateTime) patch.end = { dateTime: updates.endDateTime, timeZone: tz };

  if (Object.keys(patch).length === 0) return null;

  const res = await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    config,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Calendar API error (${res.status})`);
  return (await res.json()) as CalendarEvent;
}

export async function deleteEvent(
  config: GoogleConfig,
  calendarId: string,
  eventId: string,
): Promise<boolean> {
  const res = await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    config,
    { method: "DELETE" },
  );
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Calendar API error (${res.status})`);
  return true;
}

// ── Tool ─────────────────────────────────────────────────────

export default defineTool({
  name: "google_calendar",
  description:
    "Admin-only low-level calendar management. DO NOT use this for personal events — use the 'calendar' tool instead. " +
    "This tool operates on raw calendar IDs and is only for debugging or operations on specific calendars. " +
    "Actions: list, create, update, delete, calendars.",

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
    eventId: param.string("Event ID. Required for update and delete."),
    calendarId: param.string("Calendar ID. Required for all actions except 'calendars'. Use 'calendars' action to find IDs."),
    maxResults: param.number("Max events to return for list (1-50, default 10).", { minimum: 1, maximum: 50 }),
    daysAhead: param.number("Days ahead to search for list (1-365, default 14).", { minimum: 1, maximum: 365 }),
  },

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  handler: async (
    { action, summary, description, location, startDateTime, endDateTime, eventId, calendarId, maxResults, daysAhead },
    { toolConfig },
  ) => {
    const config = extractGoogleConfig(toolConfig);

    // Never fall back to primary — require an explicit calendar ID (except for 'calendars' action)
    if (!calendarId && action !== "calendars") {
      return "Error: calendarId is required. Use the 'calendars' action to find available calendar IDs, or use the 'calendar' tool for personal event management.";
    }
    const cal = calendarId || "primary";

    try {
      switch (action) {
        // ── List ─────────────────────────────────────────────
        case "list": {
          const events = await listEvents(config, cal, {
            maxResults: maxResults ?? 10,
            daysAhead: daysAhead ?? 14,
          });
          const days = daysAhead ?? 14;

          if (events.length === 0) {
            return { text: `No upcoming events in the next ${days} days.`, data: { action: "list" as const, count: 0, events: [] } };
          }

          let text = `Upcoming events (next ${days} days):\n`;
          for (let i = 0; i < events.length; i++) {
            const e = events[i];
            text += `\n${i + 1}. ${e.summary ?? "(no title)"}\n`;
            text += `   When: ${formatEventTime(e.start)} → ${formatEventTime(e.end)}\n`;
            if (e.location) text += `   Where: ${e.location}\n`;
            if (e.description) text += `   Notes: ${e.description.slice(0, 150)}\n`;
            text += `   ID: ${e.id}\n`;
          }

          return { text, data: { action: "list" as const, count: events.length, calendarId: cal, events: events.map(e => ({ id: e.id, summary: e.summary ?? null, description: e.description ?? null, location: e.location ?? null, start: e.start, end: e.end, htmlLink: e.htmlLink ?? null, status: e.status ?? null })) } };
        }

        // ── Create ───────────────────────────────────────────
        case "create": {
          if (!summary) return "Error: summary is required for create.";
          if (!startDateTime) return "Error: startDateTime is required for create.";
          if (!endDateTime) return "Error: endDateTime is required for create.";

          const created = await createEvent(config, cal, {
            summary: summary as string,
            description: description as string | undefined,
            location: location as string | undefined,
            startDateTime: startDateTime as string,
            endDateTime: endDateTime as string,
          });

          let text = `Event created: ${created.summary}\n`;
          text += `When: ${formatEventTime(created.start)} → ${formatEventTime(created.end)}\n`;
          if (created.location) text += `Where: ${created.location}\n`;
          text += `ID: ${created.id}\n`;
          if (created.htmlLink) text += `Link: ${created.htmlLink}`;

          return { text, data: { action: "create" as const, event: { id: created.id, summary: created.summary ?? null, description: created.description ?? null, location: created.location ?? null, start: created.start, end: created.end, htmlLink: created.htmlLink ?? null } } };
        }

        // ── Update ───────────────────────────────────────────
        case "update": {
          if (!eventId) return "Error: eventId is required for update.";

          const updated = await updateEvent(config, cal, eventId as string, {
            summary: summary as string | undefined,
            description: description as string | undefined,
            location: location as string | undefined,
            startDateTime: startDateTime as string | undefined,
            endDateTime: endDateTime as string | undefined,
          });
          if (!updated) return `Error: event not found or no fields to update (ID: ${eventId}).`;

          let text = `Event updated: ${updated.summary}\n`;
          text += `When: ${formatEventTime(updated.start)} → ${formatEventTime(updated.end)}\n`;
          if (updated.location) text += `Where: ${updated.location}\n`;
          text += `ID: ${updated.id}`;

          return { text, data: { action: "update" as const, event: { id: updated.id, summary: updated.summary ?? null, description: updated.description ?? null, location: updated.location ?? null, start: updated.start, end: updated.end } } };
        }

        // ── Delete ───────────────────────────────────────────
        case "delete": {
          if (!eventId) return "Error: eventId is required for delete.";

          const deleted = await deleteEvent(config, cal, eventId as string);
          if (!deleted) return `Error: event not found (ID: ${eventId}).`;

          return { text: `Event deleted (ID: ${eventId}).`, data: { action: "delete" as const, eventId } };
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

          let text = "Available calendars:\n";
          for (const c of data.items) {
            const primary = c.primary ? " (primary)" : "";
            text += `\n  ${c.summary}${primary}\n`;
            text += `  ID: ${c.id}\n`;
            text += `  Access: ${c.accessRole}\n`;
          }

          return { text, data: { action: "calendars" as const, count: data.items.length, calendars: data.items.map(c => ({ id: c.id, summary: c.summary, primary: c.primary ?? false, accessRole: c.accessRole })) } };
        }

        default:
          return `Error: unknown action "${action}". Use: list, create, update, delete, calendars.`;
      }
    } catch (err) {
      resetGoogleToken();
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: calendar operation failed: ${msg}`;
    }
  },
});

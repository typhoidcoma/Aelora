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
    "Read-only calendar admin tool. Lists events on a specific calendar or lists available calendars. " +
    "To create, update, or delete events use the 'calendar' tool instead.",

  params: {
    action: param.enum(
      "The action to perform.",
      ["list", "calendars"] as const,
      { required: true },
    ),
    calendarId: param.string("Calendar ID. Required for list. Use 'calendars' action to find IDs."),
    maxResults: param.number("Max events to return for list (1-50, default 10).", { minimum: 1, maximum: 50 }),
    daysAhead: param.number("Days ahead to search for list (1-365, default 14).", { minimum: 1, maximum: 365 }),
  },

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  handler: async (
    { action, calendarId, maxResults, daysAhead },
    { toolConfig },
  ) => {
    const config = extractGoogleConfig(toolConfig);

    try {
      switch (action) {
        case "list": {
          if (!calendarId) {
            return "Error: calendarId is required. Use 'calendars' to find IDs, or use the 'calendar' tool for personal events.";
          }

          const events = await listEvents(config, calendarId as string, {
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

          return { text, data: { action: "list" as const, count: events.length, calendarId, events: events.map(e => ({ id: e.id, summary: e.summary ?? null, description: e.description ?? null, location: e.location ?? null, start: e.start, end: e.end, htmlLink: e.htmlLink ?? null, status: e.status ?? null })) } };
        }

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
          return "Error: use the 'calendar' tool to create, update, or delete events.";
      }
    } catch (err) {
      resetGoogleToken();
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: calendar operation failed: ${msg}`;
    }
  },
});

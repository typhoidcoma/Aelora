import { createDAVClient } from "tsdav";
import { randomUUID } from "node:crypto";
import { defineTool, param } from "./types.js";

// ============================================================
// Types
// ============================================================

type DAVClientInstance = Awaited<ReturnType<typeof createDAVClient>>;

type ParsedEvent = {
  uid: string;
  summary: string;
  description: string;
  location: string;
  dtstart: string;
  dtend: string;
  url: string;
  etag: string;
};

// ============================================================
// Cached client
// ============================================================

export { type DAVClientInstance, type ParsedEvent };

let cachedClient: DAVClientInstance | null = null;

export async function getClient(config: {
  serverUrl: string;
  username: string;
  password: string;
  authMethod: string;
}): Promise<DAVClientInstance> {
  if (cachedClient) return cachedClient;

  cachedClient = await createDAVClient({
    serverUrl: config.serverUrl,
    credentials: {
      username: config.username,
      password: config.password,
    },
    authMethod: config.authMethod as "Basic" | "Oauth" | "Bearer",
    defaultAccountType: "caldav",
  });

  return cachedClient;
}

// ============================================================
// ICS helpers
// ============================================================

function toICSDateTime(iso: string): string {
  // Convert ISO 8601 to iCalendar YYYYMMDDTHHMMSSZ
  const d = new Date(iso);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function buildICS(opts: {
  uid: string;
  summary: string;
  dtstart: string;
  dtend: string;
  description?: string;
  location?: string;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Aelora//Calendar//EN",
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `DTSTAMP:${toICSDateTime(new Date().toISOString())}`,
    `DTSTART:${toICSDateTime(opts.dtstart)}`,
    `DTEND:${toICSDateTime(opts.dtend)}`,
    `SUMMARY:${opts.summary}`,
  ];

  if (opts.description) lines.push(`DESCRIPTION:${opts.description}`);
  if (opts.location) lines.push(`LOCATION:${opts.location}`);

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

function getICSProp(ics: string, prop: string): string {
  // Match PROP:value or PROP;params:value
  const re = new RegExp(`^${prop}[;:](.*)$`, "mi");
  const m = ics.match(re);
  if (!m) return "";
  // Strip any parameter prefix (e.g., DTSTART;TZID=...:20250101T...)
  const val = m[1];
  const colonIdx = val.indexOf(":");
  // If the match was PROP;...:value, we need to get after the last colon
  // But if it was PROP:value, the regex already captured everything after PROP:
  return val;
}

function getICSDateValue(ics: string, prop: string): string {
  // Handle DTSTART:20250101T120000Z and DTSTART;TZID=America/New_York:20250101T120000
  const re = new RegExp(`^${prop}[^:]*:(.+)$`, "mi");
  const m = ics.match(re);
  if (!m) return "";
  return m[1].trim();
}

export function icsDateToISO(icsDate: string): string {
  // Convert 20250315T100000Z or 20250315T100000 to ISO
  const m = icsDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return icsDate; // Return as-is if we can't parse
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || "Z"}`;
}

export function parseICS(ics: string, url: string, etag: string): ParsedEvent {
  return {
    uid: getICSProp(ics, "UID") || "",
    summary: getICSProp(ics, "SUMMARY") || "(No title)",
    description: getICSProp(ics, "DESCRIPTION") || "",
    location: getICSProp(ics, "LOCATION") || "",
    dtstart: getICSDateValue(ics, "DTSTART"),
    dtend: getICSDateValue(ics, "DTEND"),
    url,
    etag: etag || "",
  };
}

// ============================================================
// Formatters
// ============================================================

export function formatTime(icsDate: string): string {
  const iso = icsDateToISO(icsDate);
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return icsDate;
  }
}

function formatEventList(events: ParsedEvent[]): string {
  const lines: string[] = [`**Upcoming Events** (${events.length}):\n`];

  for (const e of events) {
    lines.push(`**${e.summary}**`);
    lines.push(`  Time: ${formatTime(e.dtstart)} — ${formatTime(e.dtend)}`);
    if (e.location) lines.push(`  Location: ${e.location}`);
    if (e.description) {
      const desc = e.description.length > 100 ? e.description.slice(0, 100) + "..." : e.description;
      lines.push(`  Description: ${desc}`);
    }
    lines.push(`  URL: \`${e.url}\``);
    lines.push(`  ETag: \`${e.etag}\``);
    lines.push("");
  }

  return lines.join("\n");
}

function formatSingleEvent(e: ParsedEvent): string {
  const lines: string[] = [];
  lines.push(`**${e.summary}**`);
  lines.push(`- **Start**: ${formatTime(e.dtstart)}`);
  lines.push(`- **End**: ${formatTime(e.dtend)}`);
  if (e.location) lines.push(`- **Location**: ${e.location}`);
  if (e.description) lines.push(`- **Description**: ${e.description}`);
  lines.push(`- **URL**: \`${e.url}\``);
  lines.push(`- **ETag**: \`${e.etag}\``);
  return lines.join("\n");
}

// ============================================================
// Actions
// ============================================================

async function listEvents(
  client: DAVClientInstance,
  calendarName: string | undefined,
  opts: { maxResults?: number; daysAhead?: number },
): Promise<string> {
  const calendars = await client.fetchCalendars();
  if (calendars.length === 0) return "No calendars found on this server.";

  const calendar =
    (calendarName ? calendars.find((c) => c.displayName === calendarName) : null) ?? calendars[0];

  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + (opts.daysAhead ?? 14));

  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange: {
      start: now.toISOString(),
      end: end.toISOString(),
    },
  });

  if (!objects || objects.length === 0) return "No upcoming events found.";

  const events = objects
    .filter((o) => o.data)
    .map((o) => parseICS(o.data as string, o.url, o.etag ?? ""))
    .sort((a, b) => a.dtstart.localeCompare(b.dtstart));

  const max = opts.maxResults ?? 10;
  const sliced = events.slice(0, max);

  return formatEventList(sliced);
}

async function createEvent(
  client: DAVClientInstance,
  calendarName: string | undefined,
  opts: {
    summary?: string;
    description?: string;
    location?: string;
    startDateTime?: string;
    endDateTime?: string;
  },
): Promise<string> {
  if (!opts.summary) return "Error: summary is required for create.";
  if (!opts.startDateTime) return "Error: startDateTime is required for create.";
  if (!opts.endDateTime) return "Error: endDateTime is required for create.";

  const calendars = await client.fetchCalendars();
  if (calendars.length === 0) return "No calendars found on this server.";

  const calendar =
    (calendarName ? calendars.find((c) => c.displayName === calendarName) : null) ?? calendars[0];

  const uid = `${randomUUID()}@aelora`;
  const filename = `${uid}.ics`;

  const ics = buildICS({
    uid,
    summary: opts.summary,
    dtstart: opts.startDateTime,
    dtend: opts.endDateTime,
    description: opts.description,
    location: opts.location,
  });

  const res = await client.createCalendarObject({
    calendar,
    iCalString: ics,
    filename,
  });

  if (!res.ok) {
    return `Error creating event: ${res.status} ${res.statusText}`;
  }

  const eventUrl = new URL(filename, calendar.url).toString();
  const etag = res.headers.get("etag") ?? "";

  const parsed: ParsedEvent = {
    uid,
    summary: opts.summary,
    description: opts.description ?? "",
    location: opts.location ?? "",
    dtstart: toICSDateTime(opts.startDateTime),
    dtend: toICSDateTime(opts.endDateTime),
    url: eventUrl,
    etag,
  };

  return `Event created!\n${formatSingleEvent(parsed)}`;
}

async function updateEvent(
  client: DAVClientInstance,
  opts: {
    eventUrl?: string;
    etag?: string;
    summary?: string;
    description?: string;
    location?: string;
    startDateTime?: string;
    endDateTime?: string;
  },
): Promise<string> {
  if (!opts.eventUrl) return "Error: eventUrl is required for update.";

  // Fetch current event data
  const existing = await client.fetchCalendarObjects({
    calendar: { url: opts.eventUrl.replace(/[^/]+\.ics$/, "") } as any,
    objectUrls: [opts.eventUrl],
  });

  if (!existing || existing.length === 0) return "Error: event not found at that URL.";

  let ics = existing[0].data as string;
  const currentEtag = existing[0].etag ?? opts.etag ?? "";

  // Replace fields in ICS
  if (opts.summary) ics = ics.replace(/^SUMMARY:.*$/mi, `SUMMARY:${opts.summary}`);
  if (opts.description) {
    if (/^DESCRIPTION:/mi.test(ics)) {
      ics = ics.replace(/^DESCRIPTION:.*$/mi, `DESCRIPTION:${opts.description}`);
    } else {
      ics = ics.replace(/^END:VEVENT/mi, `DESCRIPTION:${opts.description}\r\nEND:VEVENT`);
    }
  }
  if (opts.location) {
    if (/^LOCATION:/mi.test(ics)) {
      ics = ics.replace(/^LOCATION:.*$/mi, `LOCATION:${opts.location}`);
    } else {
      ics = ics.replace(/^END:VEVENT/mi, `LOCATION:${opts.location}\r\nEND:VEVENT`);
    }
  }
  if (opts.startDateTime) {
    ics = ics.replace(/^DTSTART[^:]*:.*$/mi, `DTSTART:${toICSDateTime(opts.startDateTime)}`);
  }
  if (opts.endDateTime) {
    ics = ics.replace(/^DTEND[^:]*:.*$/mi, `DTEND:${toICSDateTime(opts.endDateTime)}`);
  }

  const res = await client.updateCalendarObject({
    calendarObject: {
      url: opts.eventUrl,
      data: ics,
      etag: currentEtag,
    },
  });

  if (!res.ok) {
    return `Error updating event: ${res.status} ${res.statusText}`;
  }

  const parsed = parseICS(ics, opts.eventUrl, res.headers.get("etag") ?? currentEtag);
  return `Event updated!\n${formatSingleEvent(parsed)}`;
}

async function deleteEvent(
  client: DAVClientInstance,
  opts: { eventUrl?: string; etag?: string },
): Promise<string> {
  if (!opts.eventUrl) return "Error: eventUrl is required for delete.";

  const res = await client.deleteCalendarObject({
    calendarObject: {
      url: opts.eventUrl,
      etag: opts.etag ?? "",
    },
  });

  if (!res.ok && res.status !== 204) {
    return `Error deleting event: ${res.status} ${res.statusText}`;
  }

  return `Event deleted.`;
}

// ============================================================
// Tool export
// ============================================================

export default defineTool({
  name: "calendar",
  description:
    "Manage calendar events via CalDAV. List upcoming events, create new events, " +
    "update existing events, or delete events. Use eventUrl and etag from list/create " +
    "results to reference specific events for update/delete.",

  config: [
    "caldav.serverUrl",
    "caldav.username",
    "caldav.password",
    "caldav.authMethod",
  ],

  params: {
    action: param.enum("The calendar action to perform.", ["list", "create", "update", "delete"] as const, {
      required: true,
    }),
    summary: param.string("Event title. Required for create."),
    description: param.string("Event description. Optional for create/update."),
    location: param.string("Event location. Optional for create/update."),
    startDateTime: param.string(
      "Event start as ISO 8601 datetime (e.g. '2025-03-15T10:00:00'). Required for create.",
    ),
    endDateTime: param.string(
      "Event end as ISO 8601 datetime (e.g. '2025-03-15T11:00:00'). Required for create.",
    ),
    eventUrl: param.string("CalDAV event URL. Required for update and delete."),
    etag: param.string("Event ETag for update/delete (from list or create results)."),
    maxResults: param.number("Max events to return for list (1-50). Default: 10.", {
      minimum: 1,
      maximum: 50,
    }),
    daysAhead: param.number("How many days ahead to list. Default: 14.", {
      minimum: 1,
      maximum: 365,
    }),
  },

  handler: async (
    { action, summary, description, location, startDateTime, endDateTime, eventUrl, etag, maxResults, daysAhead },
    { toolConfig },
  ) => {
    const { serverUrl, username, password, authMethod } = toolConfig as {
      serverUrl: string;
      username: string;
      password: string;
      authMethod: string;
    };

    const calendarName = (toolConfig as Record<string, unknown>).calendarName as string | undefined;

    let client: DAVClientInstance;
    try {
      client = await getClient({ serverUrl, username, password, authMethod: authMethod || "Basic" });
    } catch (err) {
      cachedClient = null; // Reset on failure so next call retries
      return `Error connecting to CalDAV server: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      switch (action) {
        case "list":
          return await listEvents(client, calendarName, { maxResults, daysAhead });
        case "create":
          return await createEvent(client, calendarName, { summary, description, location, startDateTime, endDateTime });
        case "update":
          return await updateEvent(client, { eventUrl, etag, summary, description, location, startDateTime, endDateTime });
        case "delete":
          return await deleteEvent(client, { eventUrl, etag });
        default:
          return `Unknown action "${action}". Use list, create, update, or delete.`;
      }
    } catch (err) {
      cachedClient = null; // Reset client on error
      return `Calendar error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { loadCalendarNotified, saveCalendarNotified } from "./state.js";
import { googleFetch, type GoogleConfig } from "./tools/_google-auth.js";

const REMINDER_MINUTES = 15;
const CAL_BASE = "https://www.googleapis.com/calendar/v3";

// Track which events we've already sent reminders for (by event ID)
// Loaded from disk so reminders survive restarts
const notifiedEvents = new Set<string>(loadCalendarNotified());

type GoogleCalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end:   { dateTime?: string; date?: string };
};

function formatEventTime(event: GoogleCalendarEvent): string {
  const dt = event.start.dateTime;
  if (!dt) return "all day";
  try {
    return new Date(dt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return dt;
  }
}

const calendarReminder: HeartbeatHandler = {
  name: "calendar-reminder",
  description: `Sends a reminder ${REMINDER_MINUTES} minutes before upcoming Google Calendar events`,
  enabled: true,

  execute: async (ctx): Promise<string | void> => {
    const google = ctx.config.tools?.google as
      | { clientId?: string; clientSecret?: string; refreshToken?: string }
      | undefined;

    if (!google?.clientId || !google?.refreshToken) {
      return; // Google not configured
    }

    const googleConfig: GoogleConfig = {
      clientId: google.clientId,
      clientSecret: google.clientSecret ?? "",
      refreshToken: google.refreshToken,
    };

    const now = new Date();
    const windowEnd = new Date(now.getTime() + (REMINDER_MINUTES + 1) * 60_000);

    let res: Response;
    try {
      const params = new URLSearchParams({
        timeMin: now.toISOString(),
        timeMax: windowEnd.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "10",
      });
      res = await googleFetch(
        `${CAL_BASE}/calendars/primary/events?${params}`,
        googleConfig,
      );
    } catch {
      return; // Google not reachable
    }

    if (!res.ok) return;

    const data = (await res.json()) as { items?: GoogleCalendarEvent[] };
    const events = data.items ?? [];
    if (events.length === 0) return;

    const reminded: string[] = [];

    for (const event of events) {
      if (notifiedEvents.has(event.id)) continue;

      const startStr = event.start.dateTime ?? event.start.date;
      if (!startStr) continue;

      const startTime = new Date(startStr).getTime();
      const minutesUntil = (startTime - now.getTime()) / 60_000;

      if (minutesUntil > 0 && minutesUntil <= REMINDER_MINUTES) {
        notifiedEvents.add(event.id);
        saveCalendarNotified([...notifiedEvents]);

        const mins = Math.round(minutesUntil);
        const lines: string[] = [
          `**Calendar Reminder** — in ${mins} minute${mins === 1 ? "" : "s"}`,
          `**${event.summary ?? "Untitled event"}**`,
          `Time: ${formatEventTime(event)}`,
        ];
        if (event.location) lines.push(`Location: ${event.location}`);
        if (event.description) lines.push(`Notes: ${event.description.slice(0, 200)}`);

        const guildId = ctx.config.discord.guildId;
        if (guildId) {
          const { discordClient } = await import("./discord.js");
          const guild = discordClient?.guilds.cache.get(guildId);
          if (guild) {
            const channel = guild.channels.cache.find(
              (ch) => ch.isTextBased() && "send" in ch,
            );
            if (channel && "send" in channel) {
              await (channel as any).send(lines.join("\n"));
              reminded.push(event.summary ?? event.id);
            }
          }
        }
      }
    }

    if (reminded.length > 0) {
      return `sent ${reminded.length} reminder(s): ${reminded.join(", ")}`;
    }

    // Prune old notification cache periodically
    if (notifiedEvents.size > 100) {
      notifiedEvents.clear();
      saveCalendarNotified([]);
    }
  },
};

export function registerCalendarReminder(): void {
  registerHeartbeatHandler(calendarReminder);
}

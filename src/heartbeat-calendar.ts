import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { getClient, parseICS, icsDateToISO, formatTime } from "./tools/calendar.js";
import { loadCalendarNotified, saveCalendarNotified } from "./state.js";

const REMINDER_MINUTES = 15;

// Track which events we've already sent reminders for (by UID)
// Loaded from disk so reminders survive restarts
const notifiedEvents = new Set<string>(loadCalendarNotified());

const calendarReminder: HeartbeatHandler = {
  name: "calendar-reminder",
  description: `Sends a reminder ${REMINDER_MINUTES} minutes before upcoming calendar events`,
  enabled: true,

  execute: async (ctx): Promise<string | void> => {
    const caldavConfig = ctx.config.tools?.caldav as
      | { serverUrl: string; username: string; password: string; authMethod: string; calendarName?: string }
      | undefined;

    if (!caldavConfig?.serverUrl || caldavConfig.serverUrl === "YOUR_CALDAV_SERVER_URL") {
      return; // CalDAV not configured
    }

    let client;
    try {
      client = await getClient({
        serverUrl: caldavConfig.serverUrl,
        username: caldavConfig.username,
        password: caldavConfig.password,
        authMethod: caldavConfig.authMethod || "Basic",
      });
    } catch {
      return; // CalDAV server not available
    }

    const calendars = await client.fetchCalendars();
    if (calendars.length === 0) return;

    const calendar =
      (caldavConfig.calendarName
        ? calendars.find((c) => c.displayName === caldavConfig.calendarName)
        : null) ?? calendars[0];

    const now = new Date();
    const windowEnd = new Date(now.getTime() + (REMINDER_MINUTES + 1) * 60_000);

    const objects = await client.fetchCalendarObjects({
      calendar,
      timeRange: {
        start: now.toISOString(),
        end: windowEnd.toISOString(),
      },
    });

    if (!objects || objects.length === 0) return;

    const events = objects
      .filter((o) => o.data)
      .map((o) => parseICS(o.data as string, o.url, o.etag ?? ""));

    const reminded: string[] = [];

    for (const event of events) {
      if (notifiedEvents.has(event.uid)) continue;

      const startISO = icsDateToISO(event.dtstart);
      const startTime = new Date(startISO).getTime();
      const minutesUntil = (startTime - now.getTime()) / 60_000;

      if (minutesUntil > 0 && minutesUntil <= REMINDER_MINUTES) {
        notifiedEvents.add(event.uid);
        saveCalendarNotified([...notifiedEvents]);

        const mins = Math.round(minutesUntil);
        const lines: string[] = [
          `**Calendar Reminder** — in ${mins} minute${mins === 1 ? "" : "s"}`,
          `**${event.summary}**`,
          `Time: ${formatTime(event.dtstart)}`,
        ];
        if (event.location) lines.push(`Location: ${event.location}`);
        if (event.description) lines.push(`Description: ${event.description}`);

        // Send to the guild's first text channel or default channel
        const guildId = ctx.config.discord.guildId;
        if (guildId) {
          const { discordClient } = await import("./discord.js");
          const guild = discordClient?.guilds.cache.get(guildId);
          if (guild) {
            // Find the first text channel the bot can send to
            const channel = guild.channels.cache.find(
              (ch) => ch.isTextBased() && "send" in ch,
            );
            if (channel && "send" in channel) {
              await (channel as any).send(lines.join("\n"));
              reminded.push(event.summary);
            }
          }
        }
      }
    }

    if (reminded.length > 0) {
      return `sent ${reminded.length} reminder(s): ${reminded.join(", ")}`;
    }

    // Clean up old notifications (older than 1 hour)
    // We do this periodically by clearing events that started more than 1hr ago
    if (notifiedEvents.size > 100) {
      notifiedEvents.clear();
      saveCalendarNotified([]);
    }
  },
};

export function registerCalendarReminder(): void {
  registerHeartbeatHandler(calendarReminder);
}

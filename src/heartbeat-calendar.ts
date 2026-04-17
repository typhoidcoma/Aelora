import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { loadCalendarNotified, saveCalendarNotified } from "./state.js";
import { type GoogleConfig } from "./tools/_google-auth.js";
import { listEvents, type CalendarEvent } from "./tools/google-calendar.js";
import { resolveUserCalendar } from "./tools/calendar.js";
import { getAllUsers } from "./users.js";

const REMINDER_MINUTES = 15;

// Track which events we've already sent reminders for (by event ID)
// Loaded from disk so reminders survive restarts
const notifiedEvents = new Set<string>(loadCalendarNotified());

function formatEventTime(event: CalendarEvent): string {
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
  description: `Sends a reminder ${REMINDER_MINUTES} minutes before upcoming calendar events`,
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

    const guildId = ctx.config.discord.guildId;
    const now = Date.now();
    const reminded: string[] = [];

    // Check each known user's personal calendar
    const knownUsers = Object.keys(getAllUsers());

    for (const userId of knownUsers) {
      let calendarId: string | null;
      try {
        calendarId = await resolveUserCalendar(googleConfig, userId);
      } catch (err) {
        console.warn(`Heartbeat: [calendar-reminder] failed to resolve calendar for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!calendarId) continue;

      let events: CalendarEvent[];
      try {
        events = await listEvents(googleConfig, calendarId, {
          maxResults: 10,
          daysAhead: 1,
        });
      } catch (err) {
        console.warn(`Heartbeat: [calendar-reminder] failed to list events for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      for (const event of events) {
        if (notifiedEvents.has(event.id)) continue;

        const startStr = event.start.dateTime ?? event.start.date;
        if (!startStr) continue;

        const startTime = new Date(startStr).getTime();
        const minutesUntil = (startTime - now) / 60_000;

        if (minutesUntil > 0 && minutesUntil <= REMINDER_MINUTES) {
          notifiedEvents.add(event.id);
          saveCalendarNotified([...notifiedEvents]);

          const mins = Math.round(minutesUntil);
          const lines: string[] = [
            `**Calendar Reminder**  -  in ${mins} minute${mins === 1 ? "" : "s"}`,
            `**${event.summary ?? "Untitled event"}**`,
            `Time: ${formatEventTime(event)}`,
          ];
          if (event.location) lines.push(`Location: ${event.location}`);
          if (event.description) {
            const clean = event.description.replace(/\n?\[user:\d+(?::[^\]]+)?\]/, "").trim();
            if (clean) lines.push(`Notes: ${clean.slice(0, 200)}`);
          }

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
    }

    // Prune old notification cache periodically
    if (notifiedEvents.size > 200) {
      notifiedEvents.clear();
      saveCalendarNotified([]);
    }

    if (reminded.length > 0) {
      return `sent ${reminded.length} reminder(s): ${reminded.join(", ")}`;
    }
  },
};

export function registerCalendarReminder(): void {
  registerHeartbeatHandler(calendarReminder);
}

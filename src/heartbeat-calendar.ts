import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { loadCalendarNotified, saveCalendarNotified } from "./state.js";
import { googleFetch, type GoogleConfig } from "./tools/_google-auth.js";
import { getCachedSupabaseClient } from "./supabase.js";
import { listEvents, type CalendarEvent } from "./tools/google-calendar.js";

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

async function sendReminders(
  events: CalendarEvent[],
  guildId: string | undefined,
): Promise<string[]> {
  const now = Date.now();
  const reminded: string[] = [];

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
      if (event.description) lines.push(`Notes: ${event.description.slice(0, 200)}`);

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

  return reminded;
}

const calendarReminder: HeartbeatHandler = {
  name: "calendar-reminder",
  description: `Sends a reminder ${REMINDER_MINUTES} minutes before upcoming calendar events (per-user calendars)`,
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
    const allReminded: string[] = [];

    // Check per-user calendars from Supabase
    const sb = getCachedSupabaseClient();
    if (sb) {
      const { data: profiles } = await sb
        .from("user_profiles")
        .select("discord_user_id, google_calendar_id")
        .not("google_calendar_id", "is", null);

      if (profiles && profiles.length > 0) {
        for (const profile of profiles) {
          const calId = (profile as { google_calendar_id: string }).google_calendar_id;
          if (!calId) continue;

          try {
            const events = await listEvents(googleConfig, calId, {
              maxResults: 10,
              // Only look 1 day ahead for reminders (we just need the upcoming window)
              daysAhead: 1,
            });
            const reminded = await sendReminders(events, guildId);
            allReminded.push(...reminded);
          } catch {
            // Skip this user's calendar if it fails
          }
        }
      }
    }

    // Prune old notification cache periodically
    if (notifiedEvents.size > 200) {
      notifiedEvents.clear();
      saveCalendarNotified([]);
    }

    if (allReminded.length > 0) {
      return `sent ${allReminded.length} reminder(s): ${allReminded.join(", ")}`;
    }
  },
};

export function registerCalendarReminder(): void {
  registerHeartbeatHandler(calendarReminder);
}

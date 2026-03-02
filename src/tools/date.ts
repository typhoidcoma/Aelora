/**
 * Date resolution tool — converts natural language date expressions to ISO 8601.
 *
 * ALWAYS call this before passing dates to todo, calendar, or cron tools.
 * Eliminates LLM date arithmetic errors by delegating to chrono-node.
 */

import * as chrono from "chrono-node";
import { defineTool, param } from "./types.js";

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

function getTimezone(): string {
  return process.env.TZ || "UTC";
}

/**
 * Get the UTC offset in minutes for an IANA timezone at the current moment.
 * Uses the standard "compare wall clocks" technique.
 */
function tzOffsetMinutes(timezone: string): number {
  try {
    const now = new Date();
    const a = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
    const b = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
    return Math.round((a.getTime() - b.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * Format a Date as "YYYY-MM-DDTHH:mm:ss" in the given IANA timezone.
 */
function formatLocal(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): string => {
    const v = parts.find((p) => p.type === type)?.value ?? "00";
    return v === "24" ? "00" : v; // midnight edge case from some Intl implementations
  };

  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export default defineTool({
  name: "date",
  description:
    "Resolve natural language date/time expressions to ISO 8601. " +
    "Use this BEFORE passing dates to todo, calendar, or cron tools — never compute dates yourself. " +
    "Actions: 'resolve' (expression → ISO 8601 date/datetime), 'now' (current datetime).",

  params: {
    action: param.enum(
      "Action to perform.",
      ["resolve", "now"] as const,
      { required: true },
    ),
    expression: param.string(
      "Natural language date expression. Required for resolve. " +
      "Examples: 'next Friday', 'tomorrow at 3pm', 'in 2 hours', 'March 15 at noon'.",
    ),
  },

  handler: async ({ action, expression }) => {
    const timezone = getTimezone();

    // ── now ──────────────────────────────────────────────────────────────────
    if (action === "now") {
      const now = new Date();
      const local = formatLocal(now, timezone);
      const dateOnly = local.slice(0, 10);
      return {
        text:
          `Current datetime: ${local} (${timezone})\n` +
          `Date: ${dateOnly}`,
        data: { datetime: local, date: dateOnly, timezone },
      };
    }

    // ── resolve ───────────────────────────────────────────────────────────────
    if (!expression) {
      return 'Error: expression is required for resolve. Example: date(action: "resolve", expression: "next Friday at 2pm")';
    }

    const offset = tzOffsetMinutes(timezone);
    // Use en.casual with forwardDate:true so bare weekday names ("Friday") resolve
    // to the upcoming occurrence, not the past one. forwardDate must be the 3rd arg.
    const results = chrono.en.casual.parse(
      expression as string,
      { instant: new Date(), timezone: offset },
      { forwardDate: true },
    );

    if (results.length === 0) {
      return (
        `Could not parse: "${expression}". ` +
        `Try a clearer format like "next Friday at 2pm", "tomorrow", or "March 15 at noon".`
      );
    }

    const parsed = results[0];
    const date = parsed.date();
    const hasTime = parsed.start.isCertain("hour");

    const local = formatLocal(date, timezone);
    const dateOnly = local.slice(0, 10);
    const timeOnly = local.slice(11, 16);

    const lines = [
      `Resolved: "${expression}" → ${local} (${timezone})`,
      `Date (YYYY-MM-DD): ${dateOnly}`,
    ];
    if (hasTime) {
      lines.push(`Time: ${timeOnly}`);
    }
    lines.push(
      "Note: Google Tasks only supports date-level due dates. Pass the date (YYYY-MM-DD) to the todo tool.",
    );

    return {
      text: lines.join("\n"),
      data: {
        datetime: local,
        date: dateOnly,
        time: hasTime ? timeOnly : null,
        timezone,
        expression,
      },
    };
  },
});

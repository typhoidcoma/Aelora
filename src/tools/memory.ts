import { defineTool, param } from "./types.js";
import { saveFact, getFacts, deleteFact, clearScope, searchFacts } from "../memory.js";
import { readLog, searchLogs, listLogDates } from "../daily-log.js";

export default defineTool({
  name: "memory",
  description:
    "Persistent memory across restarts. " +
    "Actions: 'save' a fact, 'list' stored facts, 'forget' one by index, 'clear' a scope, " +
    "'search' facts and daily logs by keyword, 'log' to read a day's conversation log. " +
    "Scopes: 'user' (current user), 'channel' (current channel), 'global' (shared knowledge).",

  params: {
    action: param.enum(
      "The action to perform.",
      ["save", "list", "forget", "clear", "search", "log"] as const,
      { required: true },
    ),
    scope: param.enum(
      "Scope: 'user', 'channel', or 'global'.",
      ["user", "channel", "global"] as const,
    ),
    fact: param.string("The fact to remember (short, specific). Required for save.", {
      maxLength: 1000,
    }),
    index: param.number("Index of the fact to forget (from list). Required for forget."),
    query: param.string("Search query (keywords). Required for search."),
    date: param.string("Date in YYYY-MM-DD format. For 'log' action (defaults to today)."),
  },

  handler: async ({ action, scope, fact, index, query, date }, { userId, channelId }) => {
    function resolveKey(s: string | undefined): string | null {
      if (s === "user") return userId ? `user:${userId}` : null;
      if (s === "channel") return channelId ? `channel:${channelId}` : null;
      if (s === "global") return "global";
      return null;
    }

    switch (action) {
      case "save": {
        if (!fact) return "Error: fact is required for save.";
        if (!scope) return "Error: scope is required for save (user, channel, or global).";
        const key = resolveKey(scope);
        if (!key) return `Error: no ${scope} context available.`;

        const result = saveFact(key, fact);
        if (!result.success) return `Error: ${result.error}`;
        return `Remembered (${scope}): "${fact}"`;
      }

      case "list": {
        const lines: string[] = [];

        if (scope) {
          const key = resolveKey(scope);
          if (!key) return `Error: no ${scope} context available.`;
          const facts = getFacts(key);
          if (facts.length === 0) return `No facts stored for this ${scope}.`;
          lines.push(`**${scope} facts** (${facts.length}):`);
          facts.forEach((f, i) => lines.push(`${i}. ${f.fact}`));
          return lines.join("\n");
        }

        // No scope — show all available
        const globalFacts = getFacts("global");
        if (globalFacts.length > 0) {
          lines.push(`**Global facts** (${globalFacts.length}):`);
          globalFacts.forEach((f, i) => lines.push(`${i}. ${f.fact}`));
        }

        if (userId) {
          const userFacts = getFacts(`user:${userId}`);
          if (userFacts.length > 0) {
            if (lines.length > 0) lines.push("");
            lines.push(`**User facts** (${userFacts.length}):`);
            userFacts.forEach((f, i) => lines.push(`${i}. ${f.fact}`));
          }
        }

        if (channelId) {
          const channelFacts = getFacts(`channel:${channelId}`);
          if (channelFacts.length > 0) {
            if (lines.length > 0) lines.push("");
            lines.push(`**Channel facts** (${channelFacts.length}):`);
            channelFacts.forEach((f, i) => lines.push(`${i}. ${f.fact}`));
          }
        }

        if (lines.length === 0) return "No facts stored yet.";
        return lines.join("\n");
      }

      case "forget": {
        if (!scope) return "Error: scope is required for forget (user, channel, or global).";
        if (index === undefined || index === null) return "Error: index is required for forget.";
        const key = resolveKey(scope);
        if (!key) return `Error: no ${scope} context available.`;

        const ok = deleteFact(key, index as number);
        if (!ok) return `Error: invalid index ${index}. Use 'list' to see available facts.`;
        return `Forgot fact #${index} from ${scope}.`;
      }

      case "clear": {
        if (!scope) return "Error: scope is required for clear (user, channel, or global).";
        const key = resolveKey(scope);
        if (!key) return `Error: no ${scope} context available.`;

        const count = clearScope(key);
        if (count === 0) return `No facts to clear for this ${scope}.`;
        return `Cleared ${count} fact(s) from ${scope}.`;
      }

      case "search": {
        if (!query) return "Error: query is required for search.";
        const lines: string[] = [];

        // Search memory facts
        const factResults = searchFacts(query as string);
        if (factResults.length > 0) {
          lines.push(`**Memory facts matching "${query}"** (${factResults.length}):`);
          for (const r of factResults.slice(0, 20)) {
            lines.push(`- [${r.scope}#${r.index}] ${r.fact.fact}`);
          }
          if (factResults.length > 20) lines.push(`_(${factResults.length - 20} more)_`);
        }

        // Search daily logs
        const logResults = searchLogs(query as string, 10);
        if (logResults.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(`**Daily log entries matching "${query}"** (${logResults.length}):`);
          for (const r of logResults) {
            lines.push(`- [${r.date}] ${r.excerpt.slice(0, 200)}`);
          }
        }

        if (lines.length === 0) return `No results found for "${query}".`;
        return lines.join("\n");
      }

      case "log": {
        const targetDate = (date as string) || undefined;
        const content = readLog(targetDate);
        if (!content) {
          const available = listLogDates().slice(0, 10);
          if (available.length === 0) return "No daily logs exist yet.";
          return `No log for ${targetDate ?? "today"}. Available dates: ${available.join(", ")}`;
        }
        // Cap output to avoid overwhelming the LLM context
        const capped = content.length > 3000 ? content.slice(-3000) + "\n_(truncated — oldest entries omitted)_" : content;
        return `**Daily log for ${targetDate ?? "today"}:**\n\n${capped}`;
      }

      default:
        return `Unknown action "${action}". Use save, list, forget, clear, search, or log.`;
    }
  },
});

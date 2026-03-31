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
        if (!result.success) {
          return {
            text: `Did not save fact in ${scope}: ${result.error ?? "already remembered"}.`,
            data: { action: "save", scope, fact, duplicate: true, error: result.error ?? "duplicate" },
          };
        }
        return {
          text: `Remembered in ${scope}: "${fact}".`,
          data: { action: "save", scope, fact },
        };
      }

      case "list": {
        const lines: string[] = [];

        if (scope) {
          const key = resolveKey(scope);
          if (!key) return `Error: no ${scope} context available.`;
          const facts = getFacts(key);
          if (facts.length === 0) return { text: `No facts stored for this ${scope}.`, data: { action: "list", scope, count: 0, facts: [] } };
          lines.push(`**${scope} facts** (${facts.length}):`);
          facts.forEach((f, i) => lines.push(`${i}. ${f.fact}`));
          return { text: lines.join("\n"), data: { action: "list", scope, count: facts.length, facts: facts.map((f, i) => ({ index: i, fact: f.fact })) } };
        }

        // No scope  -  show all available
        const globalFacts = getFacts("global");
        const userFacts = userId ? getFacts(`user:${userId}`) : [];
        const channelFacts = channelId ? getFacts(`channel:${channelId}`) : [];

        if (globalFacts.length > 0) {
          lines.push(`**Global facts** (${globalFacts.length}):`);
          globalFacts.forEach((f, i) => lines.push(`${i}. ${f.fact}`));
        }

        if (userFacts.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(`**User facts** (${userFacts.length}):`);
          userFacts.forEach((f, i) => lines.push(`${i}. ${f.fact}`));
        }

        if (channelFacts.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(`**Channel facts** (${channelFacts.length}):`);
          channelFacts.forEach((f, i) => lines.push(`${i}. ${f.fact}`));
        }

        if (lines.length === 0) return { text: "No facts stored yet.", data: { action: "list", count: 0, scopes: {} } };

        const scopesData: Record<string, { fact: string }[]> = {};
        if (globalFacts.length > 0) scopesData.global = globalFacts.map(f => ({ fact: f.fact }));
        if (userFacts.length > 0) scopesData.user = userFacts.map(f => ({ fact: f.fact }));
        if (channelFacts.length > 0) scopesData.channel = channelFacts.map(f => ({ fact: f.fact }));
        return { text: lines.join("\n"), data: { action: "list", scopes: scopesData } };
      }

      case "forget": {
        if (!scope) return "Error: scope is required for forget (user, channel, or global).";
        if (index === undefined || index === null) return "Error: index is required for forget.";
        const key = resolveKey(scope);
        if (!key) return `Error: no ${scope} context available.`;

        const ok = deleteFact(key, index as number);
        if (!ok) {
          return {
            text: `Did not forget fact ${index} from ${scope}: invalid index.`,
            data: { action: "forget", scope, index, error: "invalid index" },
          };
        }
        return {
          text: `Forgot fact ${index} from ${scope}.`,
          data: { action: "forget", scope, index },
        };
      }

      case "clear": {
        if (!scope) return "Error: scope is required for clear (user, channel, or global).";
        const key = resolveKey(scope);
        if (!key) return `Error: no ${scope} context available.`;

        const count = clearScope(key);
        return {
          text: `Cleared ${count} fact${count === 1 ? "" : "s"} from ${scope}.`,
          data: { action: "clear", scope, cleared: count },
        };
      }

      case "search": {
        if (!query) return "Error: query is required for search.";
        const lines: string[] = [];

        // Search memory facts
        const factResults = await searchFacts(query as string);
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

        if (lines.length === 0) return { text: `No results found for "${query}".`, data: { action: "search", query, facts: [], logs: [] } };
        return { text: lines.join("\n"), data: { action: "search", query, facts: factResults.slice(0, 20).map(r => ({ scope: r.scope, index: r.index, fact: r.fact.fact })), logs: logResults.map(r => ({ date: r.date, excerpt: r.excerpt })) } };
      }

      case "log": {
        const targetDate = (date as string) || undefined;
        const content = readLog(targetDate);
        if (!content) {
          const available = listLogDates().slice(0, 10);
          if (available.length === 0) return "No daily logs exist yet.";
          return { text: `No log for ${targetDate ?? "today"}. Available dates: ${available.join(", ")}`, data: { action: "log", date: targetDate ?? null, available } };
        }
        // Cap output to avoid overwhelming the LLM context
        const capped = content.length > 3000 ? content.slice(-3000) + "\n_(truncated  -  oldest entries omitted)_" : content;
        return { text: `**Daily log for ${targetDate ?? "today"}:**\n\n${capped}`, data: { action: "log", date: targetDate ?? null } };
      }

      default:
        return `Error: unknown action "${action}". Use save, list, forget, clear, search, or log.`;
    }
  },
});

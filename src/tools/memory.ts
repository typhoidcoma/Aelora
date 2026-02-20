import { defineTool, param } from "./types.js";
import { saveFact, getFacts, deleteFact, clearScope } from "../memory.js";

export default defineTool({
  name: "memory",
  description:
    "Remember facts about users or channels that persist across restarts. " +
    "Use 'save' to store a short fact, 'list' to see stored facts, 'forget' to remove one, 'clear' to wipe a scope. " +
    "Facts are injected into the system prompt automatically so you can recall them later.",

  params: {
    action: param.enum(
      "The action to perform.",
      ["save", "list", "forget", "clear"] as const,
      { required: true },
    ),
    scope: param.enum(
      "Scope: 'user' for the current user, 'channel' for the current channel.",
      ["user", "channel"] as const,
    ),
    fact: param.string("The fact to remember (short, specific). Required for save.", {
      maxLength: 300,
    }),
    index: param.number("Index of the fact to forget (from list). Required for forget."),
  },

  handler: async ({ action, scope, fact, index }, { userId, channelId }) => {
    function resolveKey(s: string | undefined): string | null {
      if (s === "user") return userId ? `user:${userId}` : null;
      if (s === "channel") return channelId ? `channel:${channelId}` : null;
      return null;
    }

    switch (action) {
      case "save": {
        if (!fact) return "Error: fact is required for save.";
        if (!scope) return "Error: scope is required for save (user or channel).";
        const key = resolveKey(scope);
        if (!key) return `Error: no ${scope} context available.`;

        const result = saveFact(key, fact);
        if (!result.success) return `Error: ${result.error}`;
        return `Remembered (${scope}): "${fact}"`;
      }

      case "list": {
        const lines: string[] = [];

        // If scope specified, show only that scope
        if (scope) {
          const key = resolveKey(scope);
          if (!key) return `Error: no ${scope} context available.`;
          const facts = getFacts(key);
          if (facts.length === 0) return `No facts stored for this ${scope}.`;
          lines.push(`**${scope} facts** (${facts.length}):`);
          facts.forEach((f, i) => lines.push(`${i}. ${f.fact}`));
          return lines.join("\n");
        }

        // No scope — show both
        if (userId) {
          const userFacts = getFacts(`user:${userId}`);
          if (userFacts.length > 0) {
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
        if (!scope) return "Error: scope is required for forget (user or channel).";
        if (index === undefined || index === null) return "Error: index is required for forget.";
        const key = resolveKey(scope);
        if (!key) return `Error: no ${scope} context available.`;

        const ok = deleteFact(key, index as number);
        if (!ok) return `Error: invalid index ${index}. Use 'list' to see available facts.`;
        return `Forgot fact #${index} from ${scope}.`;
      }

      case "clear": {
        if (!scope) return "Error: scope is required for clear (user or channel).";
        const key = resolveKey(scope);
        if (!key) return `Error: no ${scope} context available.`;

        const count = clearScope(key);
        if (count === 0) return `No facts to clear for this ${scope}.`;
        return `Cleared ${count} fact(s) from ${scope}.`;
      }

      default:
        return `Unknown action "${action}". Use save, list, forget, or clear.`;
    }
  },
});

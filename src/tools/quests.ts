import { defineTool, param } from "./types.js";
import { getCachedConfig } from "../config.js";
import {
  getCachedServiceRoleClient,
  listQuests,
  getQuestById,
  createQuest,
  updateQuest,
  deleteQuest,
  appendQuestLog,
  getQuestLogs,
  type QuestRow,
} from "../supabase.js";
import { broadcastEvent, broadcastDemoTaskComplete } from "../ws.js";

function formatQuest(q: QuestRow, index?: number): string {
  const prefix = index != null ? `${index + 1}. ` : "";
  const statusIcon = q.status === "completed" ? "[x]" : "[ ]";
  const favIcon = q.is_favorite ? " ⭐" : "";
  let line = `${prefix}${statusIcon} **${q.title}**${favIcon}`;
  if (q.description) line += `\n   ${q.description.slice(0, 120)}`;
  line += `\n   Category: ${q.category} · Difficulty: ${q.difficulty} · Type: ${q.quest_type}`;
  if (q.quest_type !== "daily") {
    line += ` · Progress: ${q.current_value}/${q.target_value}`;
  }
  line += `\n   Status: ${q.status} · Favorited: ${q.is_favorite ? "yes" : "no"} · Suggested by: ${q.suggested_by}`;
  line += `\n   ID: ${q.id}`;
  return line;
}

function normalizeQuestTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Strips to alnum-ish tokens; drops filler so "i am done feeding turtles" can still match. */
const QUEST_TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "and",
  "or",
  "of",
  "in",
  "on",
  "at",
  "i",
  "im",
  "ive",
  "done",
  "finished",
  "just",
  "my",
  "me",
]);

function significantQuestTokens(norm: string): string[] {
  return norm
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9']/g, ""))
    .filter((t) => t.length > 0 && !QUEST_TITLE_STOP_WORDS.has(t));
}

/**
 * Fraction of needle's significant tokens that match some token in the title (exact, shared prefix, or substring).
 * Fixes cases like "feed the turtles" vs "Feeding the turtles" where neither full string contains the other.
 */
function needleTokenMatchFraction(needleNorm: string, titleNorm: string): number {
  const need = significantQuestTokens(needleNorm);
  if (need.length === 0) return 0;
  const titleTokens = significantQuestTokens(titleNorm);
  let hits = 0;
  for (const n of need) {
    let ok = false;
    for (const t of titleTokens) {
      if (n === t) {
        ok = true;
        break;
      }
      if (n.length >= 2 && t.length >= 2 && (t.startsWith(n) || n.startsWith(t))) {
        ok = true;
        break;
      }
      if (n.length >= 3 && (t.includes(n) || n.includes(t))) {
        ok = true;
        break;
      }
    }
    if (ok) hits++;
  }
  return hits / need.length;
}

function pickSingleFuzzyQuest(
  needleNorm: string,
  quests: QuestRow[],
):
  | { quest: QuestRow }
  | { error: string }
  | null {
  type Scored = { q: QuestRow; score: number };
  const scored: Scored[] = quests.map((q) => ({
    q,
    score: needleTokenMatchFraction(needleNorm, normalizeQuestTitle(q.title)),
  }));
  const perfect = scored.filter((s) => s.score >= 1);
  if (perfect.length === 0) return null;
  if (perfect.length === 1) return { quest: perfect[0].q };
  return {
    error: `Error: multiple quests match loosely. Use questId instead:\n${formatQuestChoices(perfect.map((p) => p.q))}`,
  };
}

function formatQuestChoices(quests: QuestRow[]): string {
  return quests
    .slice(0, 5)
    .map((q) => `- ${q.title} (ID: ${q.id}, status: ${q.status})`)
    .join("\n");
}

async function resolveQuestForMutation(
  userId: string,
  action: "complete" | "delete" | "favorite",
  questId: string | undefined,
  title: string | undefined,
): Promise<{ quest: QuestRow } | { error: string }> {
  const sbService = getCachedServiceRoleClient();
  if (!sbService) {
    return {
      error:
        "Error: Supabase service-role key is not configured. Add supabase.serviceRoleKey to settings.yaml to enable quest management.",
    };
  }

  if (questId) {
    const quest = await getQuestById(sbService, userId, questId);
    if (!quest) return { error: `Error: quest "${questId}" not found.` };
    return { quest };
  }

  const rawTitle = title?.trim();
  if (!rawTitle) {
    return { error: `Error: ${action} requires questId or title.` };
  }

  const needle = normalizeQuestTitle(rawTitle);
  const activeQuests = await listQuests(sbService, userId, {
    status: "active",
    limit: 100,
  });
  const activeExact = activeQuests.filter(
    (q) => normalizeQuestTitle(q.title) === needle,
  );
  if (activeExact.length === 1) return { quest: activeExact[0] };
  if (activeExact.length > 1) {
    return {
      error: `Error: multiple active quests match "${rawTitle}". Use questId instead:\n${formatQuestChoices(activeExact)}`,
    };
  }

  const activePartial = activeQuests.filter((q) => {
    const hay = normalizeQuestTitle(q.title);
    return hay.includes(needle) || needle.includes(hay);
  });
  if (activePartial.length === 1) return { quest: activePartial[0] };
  if (activePartial.length > 1) {
    return {
      error: `Error: multiple active quests are similar to "${rawTitle}". Use questId instead:\n${formatQuestChoices(activePartial)}`,
    };
  }

  const fuzzyActive = pickSingleFuzzyQuest(needle, activeQuests);
  if (fuzzyActive) {
    if ("error" in fuzzyActive) return fuzzyActive;
    return { quest: fuzzyActive.quest };
  }

  const allQuests = await listQuests(sbService, userId, { limit: 100 });
  const anyExact = allQuests.filter(
    (q) => normalizeQuestTitle(q.title) === needle,
  );
  if (anyExact.length === 1) return { quest: anyExact[0] };
  if (anyExact.length > 1) {
    return {
      error: `Error: multiple quests match "${rawTitle}". Use questId instead:\n${formatQuestChoices(anyExact)}`,
    };
  }

  const incomplete = allQuests.filter((q) => q.status !== "completed");
  const fuzzyIncomplete = pickSingleFuzzyQuest(needle, incomplete);
  if (fuzzyIncomplete) {
    if ("error" in fuzzyIncomplete) return fuzzyIncomplete;
    return { quest: fuzzyIncomplete.quest };
  }

  return { error: `Error: no quest found matching "${rawTitle}".` };
}

type ServiceSb = NonNullable<ReturnType<typeof getCachedServiceRoleClient>>;

/** Used by `complete` (and REST complete paths in web.ts): write completed status when still active. */
async function persistQuestCompletion(
  sbService: ServiceSb,
  userId: string,
  quest: QuestRow,
): Promise<
  | { ok: true; quest: QuestRow; transitioned: boolean }
  | { ok: false; error: string }
> {
  if (quest.status === "completed") {
    return { ok: true, quest, transitioned: false };
  }
  const completed = await updateQuest(sbService, userId, quest.id, {
    status: "completed",
    current_value: quest.target_value,
    completed_at: new Date().toISOString(),
  });
  if (!completed) {
    return { ok: false, error: "Error: failed to complete quest." };
  }
  return { ok: true, quest: completed, transitioned: true };
}

export default defineTool({
  name: "quests",
  description:
    "Personal task list in Supabase for Patyna (NOT Linear). " +
    "When the user says add/buy/remember/pick up something for their list: call action=add with title = their exact phrase. " +
    "When the user says a task is done or finished, choose by placement: (1) Task is NOT in the Top 3 (not favorited): call action=complete with title or questId — writes Supabase and triggers the app's completion celebration animation. (2) Task IS in the Top 3 (favorited): call action=finish_task with title or questId — opens Patyna's Task Complete dialog (task:finish with dialogOnly); do not use complete for a normal I'm-done unless they explicitly want to skip the dialog. For removal without completing, use delete. If questId is unknown, pass title; resolution tolerates small wording differences (e.g. feed vs feeding, fixed vs fix). " +
    "Only title is required for add — no due date, priority, assignee, or team (this store does not use them). Call immediately; do not stall asking for metadata. " +
    "Other actions: list, get, update, delete, complete, log. " +
    "When the user says favorite/star/pin a task or move/add to top 3: call action=favorite with questId or title. " +
    "When the user says unfavorite/unstar/unpin or remove from top 3: call action=unfavorite. " +
    "When the user wants to begin/start working on a Top 3 task (e.g. 'let's start homework', 'time to do X'): call action=start_task with title or questId. The task must be favorited (Top 3). Never use start_task for past-tense completion (e.g. 'X is fixed', 'I finished X', 'done with X'). " +
    "You MUST call the tool for favorite/unfavorite/start_task/finish_task — never just say you did it. Session supplies user id.",

  params: {
    action: param.enum(
      "Action to perform.",
      [
        "list",
        "get",
        "add",
        "update",
        "delete",
        "complete",
        "log",
        "favorite",
        "unfavorite",
        "start_task",
        "finish_task",
      ] as const,
      { required: true },
    ),
    questId: param.string(
      "Quest UUID. Required for get and log. For complete/delete, provide questId or title.",
    ),
    title: param.string(
      "For add: user's task text only (e.g. Buy crayons). Required for add. For complete/delete when questId is unknown, pass the existing task title to resolve it.",
    ),
    description: param.string(
      "Quest description. Optional for add and update.",
    ),
    category: param.enum(
      "Optional for add. Patyna DB allows: mental_health, fitness, learning, productivity, relationships, mindfulness. Omit to use default (productivity).",
      [
        "mental_health",
        "fitness",
        "learning",
        "productivity",
        "relationships",
        "mindfulness",
      ] as const,
    ),
    quest_type: param.enum(
      "Patyna quest_type (DB CHECK): daily (default, simple todo), milestone (progress toward target), streak.",
      ["daily", "milestone", "streak"] as const,
    ),
    target_value: param.number("Target value for counter quests. Default 1."),
    current_value: param.number(
      "Current progress value (update only, for counter quests).",
    ),
    difficulty: param.enum("Quest difficulty.", [
      "easy",
      "medium",
      "hard",
      "epic",
    ] as const),
    status: param.enum(
      "Filter quests by status (list) or set status (update).",
      ["active", "completed", "archived"] as const,
    ),
    notes: param.string("Log entry text. Required for log action."),
  },

  handler: async (
    {
      action,
      questId,
      title,
      description,
      category,
      quest_type,
      target_value,
      current_value,
      difficulty,
      status,
      notes,
    },
    context,
  ) => {
    const sbService = getCachedServiceRoleClient();

    if (!sbService) {
      return "Error: Supabase service-role key is not configured. Add supabase.serviceRoleKey to settings.yaml to enable quest management.";
    }

    const defaultQuestCategory =
      getCachedConfig().supabase?.defaultQuestCategory;

    const supabaseUserId = context.supabaseUserId;
    if (!supabaseUserId) {
      return "Error: No Supabase user identity available. The user must be signed in via Supabase Auth.";
    }

    try {
      switch (action) {
        case "list": {
          const quests = await listQuests(sbService, supabaseUserId, {
            status: status as string | undefined,
            category: category as string | undefined,
          });
          if (quests.length === 0) {
            return {
              text: "No quests found.",
              data: { action: "list", count: 0, quests: [] },
            };
          }
          const lines = quests.map((q, i) => formatQuest(q, i));
          return {
            text: `Quests (${quests.length}):\n\n${lines.join("\n\n")}`,
            data: { action: "list", count: quests.length, quests },
          };
        }

        case "get": {
          if (!questId) return "Error: questId is required for get.";
          const quest = await getQuestById(
            sbService,
            supabaseUserId,
            questId as string,
          );
          if (!quest) return `Error: quest "${questId}" not found.`;
          const logs = await getQuestLogs(sbService, quest.id, 5);
          return {
            text:
              formatQuest(quest) +
              (logs.length > 0
                ? `\n\n**Recent logs:**\n${logs.map((l) => `  - ${l.notes ?? "(no notes)"} (${new Date(l.logged_at).toLocaleDateString()})`).join("\n")}`
                : ""),
            data: { action: "get", quest, logs },
          };
        }

        case "add": {
          if (!title) return "Error: title is required for add.";
          const created = await createQuest(
            sbService,
            supabaseUserId,
            {
              title: title as string,
              ...(description != null && String(description).trim() !== ""
                ? { description: description as string }
                : {}),
              ...(category != null && String(category).trim() !== ""
                ? { category: category as string }
                : {}),
              ...(quest_type != null && String(quest_type).trim() !== ""
                ? { quest_type: quest_type as string }
                : {}),
              ...(target_value !== undefined && target_value !== null
                ? { target_value: target_value as number }
                : {}),
              ...(difficulty != null && String(difficulty).trim() !== ""
                ? { difficulty: difficulty as string }
                : {}),
            },
            defaultQuestCategory
              ? { defaultCategory: defaultQuestCategory }
              : undefined,
          );
          if (!created.ok) {
            return `Error: could not create quest in Supabase (${created.code ?? "unknown"}): ${created.error}`;
          }

          broadcastEvent("dataChanged", {
            source: "supabase",
            table: "quests",
            action: "insert",
          });
          return {
            text: `Quest created: **${created.quest.title}**\nID: ${created.quest.id}`,
            data: { action: "add", quest: created.quest },
          };
        }

        case "update": {
          if (!questId) return "Error: questId is required for update.";
          const patch: Record<string, unknown> = {};
          if (title !== undefined) patch.title = title;
          if (description !== undefined) patch.description = description;
          if (category !== undefined) patch.category = category;
          if (quest_type !== undefined) patch.quest_type = quest_type;
          if (target_value !== undefined) patch.target_value = target_value;
          if (current_value !== undefined) patch.current_value = current_value;
          if (difficulty !== undefined) patch.difficulty = difficulty;
          if (status !== undefined) patch.status = status;

          if (Object.keys(patch).length === 0)
            return "Error: provide at least one field to update.";

          const quest = await updateQuest(
            sbService,
            supabaseUserId,
            questId as string,
            patch,
          );
          if (!quest) return `Error: quest "${questId}" not found.`;

          broadcastEvent("dataChanged", {
            source: "supabase",
            table: "quests",
            action: "update",
          });
          return {
            text: `Quest updated: **${quest.title}**`,
            data: { action: "update", quest },
          };
        }

        case "delete": {
          const resolved = await resolveQuestForMutation(
            supabaseUserId,
            "delete",
            questId as string | undefined,
            title as string | undefined,
          );
          if ("error" in resolved) return resolved.error;
          const deleted = await deleteQuest(
            sbService,
            supabaseUserId,
            resolved.quest.id,
          );
          if (!deleted) return `Error: quest "${resolved.quest.id}" not found.`;

          broadcastEvent("dataChanged", {
            source: "supabase",
            table: "quests",
            action: "delete",
          });
          return {
            text: `Quest deleted: **${resolved.quest.title}**\nID: ${resolved.quest.id}`,
            data: {
              action: "delete",
              questId: resolved.quest.id,
              quest: resolved.quest,
            },
          };
        }

        case "complete": {
          const resolved = await resolveQuestForMutation(
            supabaseUserId,
            "complete",
            questId as string | undefined,
            title as string | undefined,
          );
          if ("error" in resolved) return resolved.error;
          const quest = resolved.quest;

          const outcome = await persistQuestCompletion(
            sbService,
            supabaseUserId,
            quest,
          );
          if (!outcome.ok) return outcome.error;

          if (outcome.transitioned) {
            broadcastEvent("dataChanged", {
              source: "supabase",
              table: "quests",
              action: "complete",
            });
            broadcastEvent("task:finish", {
              questId: outcome.quest.id,
              title: outcome.quest.title,
            });
            broadcastDemoTaskComplete({
              questId: outcome.quest.id,
              title: outcome.quest.title,
            });
            return {
              text: `Quest completed: **${outcome.quest.title}**`,
              data: { action: "complete", quest: outcome.quest },
            };
          }
          return {
            text: `Quest already completed: **${outcome.quest.title}**\nID: ${outcome.quest.id}`,
            data: { action: "complete", quest: outcome.quest },
          };
        }

        case "log": {
          if (!questId) return "Error: questId is required for log.";
          if (!notes) return "Error: notes is required for log.";

          const quest = await getQuestById(
            sbService,
            supabaseUserId,
            questId as string,
          );
          if (!quest) return `Error: quest "${questId}" not found.`;

          const log = await appendQuestLog(
            sbService,
            supabaseUserId,
            questId as string,
            notes as string,
          );
          if (!log) return "Error: failed to add log entry.";

          return {
            text: `Log added to **${quest.title}**: "${(notes as string).slice(0, 100)}"`,
            data: { action: "log", quest, log },
          };
        }

        case "favorite":
        case "unfavorite": {
          const favAction = action === "favorite" ? "add" : "remove";
          const resolved = await resolveQuestForMutation(
            supabaseUserId,
            "favorite",
            questId as string | undefined,
            title as string | undefined,
          );
          if ("error" in resolved) return resolved.error;
          const quest = resolved.quest;

          const updated = await updateQuest(
            sbService,
            supabaseUserId,
            quest.id,
            {
              is_favorite: favAction === "add",
            },
          );
          if (!updated)
            return `Error: failed to update favorite status for quest "${quest.id}".`;

          broadcastEvent("dataChanged", {
            source: "supabase",
            table: "quests",
            action: "update",
          });
          broadcastEvent("task:top3", {
            action: favAction,
            questId: quest.id,
            title: quest.title,
          });

          const verb = favAction === "add" ? "added to" : "removed from";
          return {
            text: `**${quest.title}** ${verb} top 3.`,
            data: { action: favAction, questId: quest.id, title: quest.title },
          };
        }

        case "start_task": {
          const resolved = await resolveQuestForMutation(
            supabaseUserId,
            "favorite",
            questId as string | undefined,
            title as string | undefined,
          );
          if ("error" in resolved) return resolved.error;
          const quest = resolved.quest;

          if (!quest.is_favorite) {
            return `Error: "${quest.title}" is not in the Top 3. Only favorited tasks can be started.`;
          }
          if (quest.status === "completed") {
            return `Error: "${quest.title}" is already completed.`;
          }

          broadcastEvent("task:start", {
            questId: quest.id,
            title: quest.title,
          });

          return {
            text: `Started task: **${quest.title}**`,
            data: {
              action: "start_task",
              questId: quest.id,
              title: quest.title,
            },
          };
        }

        case "finish_task": {
          const resolved = await resolveQuestForMutation(
            supabaseUserId,
            "favorite",
            questId as string | undefined,
            title as string | undefined,
          );
          if ("error" in resolved) return resolved.error;
          const quest = resolved.quest;

          if (!quest.is_favorite) {
            return `Error: "${quest.title}" is not in the Top 3. finish_task only opens the Task Complete dialog for favorited tasks; use action=complete to mark a task done in Supabase.`;
          }
          if (quest.status === "completed") {
            return `Error: "${quest.title}" is already completed.`;
          }

          broadcastEvent("task:finish", {
            questId: quest.id,
            title: quest.title,
            dialogOnly: true,
          });

          return {
            text: `Task complete dialog opened for **${quest.title}**. It is not saved as done until the user confirms or you call action=complete.`,
            data: {
              action: "finish_task",
              questId: quest.id,
              title: quest.title,
              dialogOnly: true,
            },
          };
        }

        default:
          return `Error: unknown action "${action}".`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

import { defineTool, param } from "./types.js";
import { getCachedSupabaseClient, getUserStats, getPendingLifeEvents, upsertLifeEvent, ensureUserProfile, type LifeEventRow } from "../supabase.js";
import { scoreTask, ACHIEVEMENTS, type LifeCategory, type ScoreInput } from "../scoring.js";
import { listTodos } from "./todo.js";

// ============================================================
// Helpers
// ============================================================

function getUserId(toolConfig: Record<string, unknown> | undefined): string {
  const uid = toolConfig?.discordUserId as string | undefined;
  if (!uid) throw new Error("Discord user ID not available in tool context.");
  return uid;
}

function lifeEventToScoreInput(ev: LifeEventRow, catStats?: { avgSmeqActual: number; completionCount: number; personalBias: number } | null): ScoreInput {
  return {
    title:                ev.title,
    description:          ev.description ?? undefined,
    category:             ev.category as LifeCategory,
    dueDate:              ev.due_date ?? undefined,
    priority:             ev.priority,
    impactLevel:          ev.impact_level ?? undefined,
    irreversible:         ev.irreversible ?? undefined,
    affectsOthers:        ev.affects_others ?? undefined,
    smeqEstimate:         ev.smeq_estimate ?? undefined,
    estimatedMinutes:     ev.estimated_minutes ?? undefined,
    sizeLabel:            ev.size_label ?? undefined,
    avgSmeqActual:        catStats?.avgSmeqActual ?? undefined,
    personalBias:         catStats?.personalBias ?? 1.0,
    categoryCompletionCount: catStats?.completionCount ?? 0,
  };
}

function scoreTierLabel(score: number): string {
  if (score >= 75) return "🔴 Critical";
  if (score >= 55) return "🟠 High";
  if (score >= 35) return "🟡 Medium";
  return "⚪ Low";
}

// ============================================================
// Google Tasks → Supabase sync helper
// ============================================================

async function syncGoogleTasksForUser(
  sb: ReturnType<typeof getCachedSupabaseClient> & object,
  discordUserId: string,
  toolConfig: Record<string, unknown>,
): Promise<void> {
  const { clientId, clientSecret, refreshToken } = toolConfig as Record<string, string>;
  if (!clientId || !clientSecret || !refreshToken) return;

  await ensureUserProfile(sb, discordUserId);
  const items = await listTodos({ clientId, clientSecret, refreshToken }, "@default", "pending");

  for (const item of items) {
    await upsertLifeEvent(sb, {
      discord_user_id:   discordUserId,
      title:             item.title,
      description:       item.description ?? null,
      category:          "tasks",
      source:            "google_tasks",
      external_uid:      item.uid,
      priority:          item.priority,
      due_date:          item.dueDate ?? null,
      completed:         false,
      completed_at:      null,
      estimated_minutes: null,
      size_label:        null,
      impact_level:      null,
      irreversible:      null,
      affects_others:    null,
      smeq_estimate:     null,
      tags:              null,
    });
  }
}

// ============================================================
// Tool definition
// ============================================================

export default defineTool({
  name: "scoring",
  description:
    "View Aelora scoring data. Actions: stats (XP/streak/achievements), leaderboard " +
    "(top tasks ranked by score), achievements (list locked/unlocked).",

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  params: {
    action: param.enum(
      "Action to perform.",
      ["stats", "leaderboard", "achievements"] as const,
      { required: true },
    ),
    category: param.enum(
      "Filter leaderboard by life category.",
      ["tasks", "health", "finance", "social", "work"] as const,
    ),
    limit: param.number("Max items to return. Default 10."),
  },

  handler: async (
    { action, category, limit },
    { toolConfig, userId },
  ) => {
    const sb = getCachedSupabaseClient();
    const discordUserId = (userId as string | null) ?? (toolConfig?.discordUserId as string | undefined);
    if (!discordUserId) {
      return "Error: Scoring requires a Discord user context. Run this in a Discord channel or DM.";
    }

    switch (action) {
      // ──────────────────────────────────────────────────────
      case "stats": {
        if (!sb) return "Supabase is not configured. Add supabase.url and supabase.anonKey to settings.yaml.";
        const data = await getUserStats(sb, discordUserId);
        if (!data) {
          return "No stats yet — complete your first task to start earning XP!";
        }

        const { profile, categoryStats, achievements } = data;
        const lines: string[] = [
          `**Aelora Scoring Stats**`,
          `**Total XP:** ${profile.total_points.toLocaleString()} pts`,
          `**Streak:** ${profile.current_streak} day${profile.current_streak === 1 ? "" : "s"} (longest: ${profile.longest_streak})`,
          `**Achievements:** ${achievements.length} / ${ACHIEVEMENTS.length} unlocked`,
        ];

        if (categoryStats.length > 0) {
          lines.push("\n**Category Breakdown:**");
          for (const cs of categoryStats) {
            lines.push(`  ${cs.category}: ${cs.completion_count} tasks · avg score ${Math.round(cs.avg_score)}`);
          }
        }

        return {
          text: lines.join("\n"),
          data: { profile, categoryStats, achievements },
        };
      }

      // ──────────────────────────────────────────────────────
      case "leaderboard": {
        const lim = Math.min(Number(limit ?? 10), 50);

        if (sb) {
          // Sync Google Tasks into life_events before querying
          try { await syncGoogleTasksForUser(sb, discordUserId, toolConfig); } catch { /* non-fatal */ }

          const events = await getPendingLifeEvents(sb, discordUserId, category as string | undefined, lim * 3);
          const userStats = await getUserStats(sb, discordUserId);

          const catStatMap = new Map(
            (userStats?.categoryStats ?? []).map((cs) => [cs.category, cs]),
          );

          const scored = events
            .map((ev) => {
              const cs = catStatMap.get(ev.category);
              const input = lifeEventToScoreInput(ev, cs ? { avgSmeqActual: cs.avg_smeq_actual, completionCount: cs.completion_count, personalBias: cs.personal_bias } : null);
              const breakdown = scoreTask(input);
              return { ev, breakdown };
            })
            .sort((a, b) => b.breakdown.total - a.breakdown.total)
            .slice(0, lim);

          if (scored.length === 0) {
            return { text: "No pending tasks found. Add some tasks to get started!", data: { tasks: [] } };
          }

          const lines = scored.map(({ ev, breakdown }, i) => {
            const tier = scoreTierLabel(breakdown.total);
            let line = `${i + 1}. **[${breakdown.total}] ${tier}** ${ev.title}`;
            if (ev.due_date) line += ` _(due ${ev.due_date.slice(0, 10)})_`;
            line += `\n   U:${breakdown.urgency} I:${breakdown.impact} E:${breakdown.effort} C:${breakdown.context} · ${ev.category}`;
            return line;
          });

          return {
            text: `**Task Leaderboard** (by score)\n\n${lines.join("\n\n")}`,
            data: { tasks: scored.map(({ ev, breakdown }) => ({ ...ev, scoreBreakdown: breakdown })) },
          };
        }

        // Ephemeral — no Supabase
        return "Supabase is not configured. Connect Supabase to see persisted task scores.";
      }

      // ──────────────────────────────────────────────────────
      case "achievements": {
        const unlockedIds = new Set<string>();

        if (sb) {
          const data = await getUserStats(sb, discordUserId);
          if (data) {
            data.achievements.forEach((a) => unlockedIds.add(a.achievement_id));
          }
        }

        const lines = ACHIEVEMENTS.map((ach) => {
          const unlocked = unlockedIds.has(ach.id);
          return `${unlocked ? "✅" : "🔒"} **${ach.name}** — ${ach.description}`;
        });

        return {
          text: `**Achievements** (${unlockedIds.size}/${ACHIEVEMENTS.length} unlocked)\n\n${lines.join("\n")}`,
          data: {
            total: ACHIEVEMENTS.length,
            unlocked: unlockedIds.size,
            achievements: ACHIEVEMENTS.map((a) => ({ ...a, unlocked: unlockedIds.has(a.id) })),
          },
        };
      }

      default:
        return `Error: unknown action "${action}".`;
    }
  },
});

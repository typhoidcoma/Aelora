import { defineTool, param } from "./types.js";
import { getCachedSupabaseClient, getUserStats, getPendingLifeEvents, getRecentScoringEvents, upsertLifeEvent, upsertCategoryStats, type LifeEventRow } from "../supabase.js";
import { scoreTask, ACHIEVEMENTS, processCompletion, type LifeCategory, type ScoreInput, type UserState } from "../scoring.js";

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
// Tool definition
// ============================================================

export default defineTool({
  name: "scoring",
  description:
    "Access the Aelora scoring system. Actions: stats (XP/streak/achievements), leaderboard " +
    "(top tasks by score), add_event (create a non-Google life event), set_metadata (set " +
    "SMEQ/impact/size on a task), rate_effort (report post-task SMEQ for adaptive learning), " +
    "achievements (list locked/unlocked).",

  params: {
    action: param.enum(
      "Action to perform.",
      ["stats", "leaderboard", "add_event", "set_metadata", "rate_effort", "achievements"] as const,
      { required: true },
    ),
    // leaderboard
    category: param.enum(
      "Filter leaderboard by life category.",
      ["tasks", "health", "finance", "social", "work"] as const,
    ),
    limit: param.number("Max items to return. Default 10."),
    // add_event
    title: param.string("Event title. Required for add_event."),
    description: param.string("Event description. Optional."),
    priority: param.enum("Priority.", ["low", "medium", "high"] as const),
    dueDate: param.date("Due date (YYYY-MM-DD). Optional."),
    estimatedMinutes: param.number("Estimated minutes to complete. Used to infer SMEQ if smeqEstimate not set."),
    smeqEstimate: param.number("Pre-task SMEQ estimate 0–150 (0=no effort, 150=extreme). See SMEQ verbal anchors."),
    impactLevel: param.enum("Impact level.", ["trivial", "low", "moderate", "high", "critical"] as const),
    sizeLabel: param.enum("Size label.", ["micro", "small", "medium", "large", "epic"] as const),
    irreversible: param.boolean("Set true if missing the window can't be recovered."),
    affectsOthers: param.boolean("Set true if completion impacts other people."),
    // set_metadata / rate_effort
    eventId: param.string("Life event UUID for set_metadata and rate_effort."),
    smeqActual: param.number("Post-completion SMEQ (0–150). Report after finishing a task for adaptive learning."),
  },

  handler: async (
    {
      action,
      category,
      limit,
      title,
      description,
      priority,
      dueDate,
      estimatedMinutes,
      smeqEstimate,
      impactLevel,
      sizeLabel,
      irreversible,
      affectsOthers,
      eventId,
      smeqActual,
    },
    { toolConfig },
  ) => {
    const sb = getCachedSupabaseClient();
    let discordUserId: string;
    try {
      discordUserId = getUserId(toolConfig as Record<string, unknown> | undefined);
    } catch {
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
      case "add_event": {
        if (!sb) return "Supabase is not configured.";
        if (!title) return "Error: title is required for add_event.";

        const row = await upsertLifeEvent(sb, {
          discord_user_id:   discordUserId,
          title:             title as string,
          description:       (description as string | undefined) ?? null,
          category:          (category as LifeCategory | undefined) ?? "tasks",
          source:            "discord",
          external_uid:      null,
          priority:          (priority as "low" | "medium" | "high" | undefined) ?? "medium",
          due_date:          (dueDate as string | undefined) ?? null,
          completed:         false,
          completed_at:      null,
          estimated_minutes: (estimatedMinutes as number | undefined) ?? null,
          size_label:        (sizeLabel as LifeEventRow["size_label"]) ?? null,
          impact_level:      (impactLevel as LifeEventRow["impact_level"]) ?? null,
          irreversible:      (irreversible as boolean | undefined) ?? null,
          affects_others:    (affectsOthers as boolean | undefined) ?? null,
          smeq_estimate:     (smeqEstimate as number | undefined) ?? null,
          tags:              null,
        });

        if (!row) return "Error: failed to create life event.";

        const input = lifeEventToScoreInput(row);
        const breakdown = scoreTask(input);

        return {
          text: `Life event created: **${row.title}**\nScore: **${breakdown.total}/100** (${scoreTierLabel(breakdown.total)})\nU:${breakdown.urgency} I:${breakdown.impact} E:${breakdown.effort} C:${breakdown.context}\nID: ${row.id}`,
          data: { event: row, scoreBreakdown: breakdown },
        };
      }

      // ──────────────────────────────────────────────────────
      case "set_metadata": {
        if (!sb) return "Supabase is not configured.";
        if (!eventId) return "Error: eventId is required for set_metadata.";

        const updates: Partial<LifeEventRow> = {};
        if (smeqEstimate !== undefined)   updates.smeq_estimate   = smeqEstimate as number;
        if (impactLevel !== undefined)    updates.impact_level    = impactLevel as LifeEventRow["impact_level"];
        if (sizeLabel !== undefined)      updates.size_label      = sizeLabel as LifeEventRow["size_label"];
        if (irreversible !== undefined)   updates.irreversible    = irreversible as boolean;
        if (affectsOthers !== undefined)  updates.affects_others  = affectsOthers as boolean;
        if (estimatedMinutes !== undefined) updates.estimated_minutes = estimatedMinutes as number;
        if (priority !== undefined)       updates.priority        = priority as "low" | "medium" | "high";

        if (Object.keys(updates).length === 0) return "No metadata fields provided.";

        const { error } = await sb
          .from("life_events")
          .update(updates)
          .eq("id", eventId as string)
          .eq("discord_user_id", discordUserId);

        if (error) return `Error: ${error.message}`;
        return `Metadata updated for event ${eventId}.`;
      }

      // ──────────────────────────────────────────────────────
      case "rate_effort": {
        if (!sb) return "Supabase is not configured.";
        if (!eventId) return "Error: eventId is required for rate_effort.";
        if (smeqActual == null) return "Error: smeqActual (0–150) is required for rate_effort.";

        const smeqVal = Math.max(0, Math.min(150, Number(smeqActual)));

        // Update scoring_events with the actual SMEQ
        await sb
          .from("scoring_events")
          .update({ smeq_actual: smeqVal })
          .eq("life_event_id", eventId as string)
          .eq("discord_user_id", discordUserId)
          .order("completed_at", { ascending: false })
          .limit(1);

        // EMA update on category_stats
        const { data: evRow } = await sb
          .from("life_events")
          .select("category")
          .eq("id", eventId as string)
          .single();

        if (evRow) {
          const { data: cs } = await sb
            .from("category_stats")
            .select("*")
            .eq("discord_user_id", discordUserId)
            .eq("category", evRow.category)
            .single();

          if (cs) {
            const newAvg = cs.avg_smeq_actual * 0.8 + smeqVal * 0.2;
            await upsertCategoryStats(sb, {
              discord_user_id:       discordUserId,
              category:              cs.category,
              completion_count:      cs.completion_count,
              avg_score:             cs.avg_score,
              avg_hours_to_complete: cs.avg_hours_to_complete,
              avg_smeq_actual:       newAvg,
              personal_bias:         cs.personal_bias,
            });
          }
        }

        const verbals = [
          [150, "Extreme effort"],
          [130, "Enormous effort"],
          [110, "Exceptional effort"],
          [90,  "Very large effort"],
          [70,  "Considerable effort"],
          [50,  "Small effort"],
          [30,  "Very little effort"],
          [10,  "Almost no effort"],
          [0,   "No effort at all"],
        ] as [number, string][];

        const label = verbals.find(([threshold]) => smeqVal >= threshold)?.[1] ?? "No effort at all";
        return `Effort logged: SMEQ ${smeqVal} (${label}). Your ${evRow?.category ?? "category"} baseline will adapt.`;
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

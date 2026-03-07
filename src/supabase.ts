import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";

// ============================================================
// Client singleton
// ============================================================

let _client: SupabaseClient | null = null;

export function getSupabaseClient(config: Config): SupabaseClient {
  if (_client) return _client;

  if (!config.supabase?.url || !config.supabase?.anonKey) {
    throw new Error(
      "Supabase not configured. Add supabase.url and supabase.anonKey to settings.yaml.",
    );
  }

  _client = createClient(config.supabase.url, config.supabase.anonKey);
  return _client;
}

/** Returns null if Supabase is not configured (graceful degradation). */
export function tryGetSupabaseClient(config: Config): SupabaseClient | null {
  try {
    return getSupabaseClient(config);
  } catch {
    return null;
  }
}

/** Returns the already-initialized client, or null if not yet initialized. */
export function getCachedSupabaseClient(): SupabaseClient | null {
  return _client;
}

// ============================================================
// Row types (matches 001_scoring_system.sql)
// ============================================================

export type UserProfileRow = {
  discord_user_id: string;
  total_points: number;
  current_streak: number;
  longest_streak: number;
  last_completion_date: string | null;  // YYYY-MM-DD
  created_at: string;
  updated_at: string;
};

export type LifeEventRow = {
  id: string;
  discord_user_id: string;
  category: "tasks" | "health" | "finance" | "social" | "work";
  title: string;
  description: string | null;
  source: "google_tasks" | "google_calendar" | "manual" | "discord" | "linear";
  external_uid: string | null;
  priority: "low" | "medium" | "high";
  due_date: string | null;     // ISO 8601
  completed: boolean;
  completed_at: string | null;
  estimated_minutes: number | null;
  size_label: "micro" | "small" | "medium" | "large" | "epic" | null;
  impact_level: "trivial" | "low" | "moderate" | "high" | "critical" | null;
  irreversible: boolean | null;
  affects_others: boolean | null;
  smeq_estimate: number | null;  // 0-150
  tags: string[] | null;
  created_at: string;
  updated_at: string;
};

export type ScoringEventRow = {
  id: string;
  discord_user_id: string;
  life_event_id: string | null;
  score_at_completion: number;
  points_awarded: number;
  urgency_component: number;
  impact_component: number;
  effort_component: number;
  context_component: number;
  smeq_actual: number | null;   // 0-150
  hours_until_due: number | null;
  streak_at_time: number;
  completed_at: string;
};

export type CategoryStatsRow = {
  discord_user_id: string;
  category: string;
  completion_count: number;
  avg_score: number;
  avg_hours_to_complete: number;
  avg_smeq_actual: number;
  personal_bias: number;
  updated_at: string;
};

export type AchievementRow = {
  discord_user_id: string;
  achievement_id: string;
  unlocked_at: string;
};

// ============================================================
// Typed helpers
// ============================================================

/** Ensure a user_profiles row exists (upsert on first use). */
export async function ensureUserProfile(
  sb: SupabaseClient,
  discordUserId: string,
): Promise<void> {
  await sb.from("user_profiles").upsert(
    { discord_user_id: discordUserId },
    { onConflict: "discord_user_id", ignoreDuplicates: true },
  );
}

/** Upsert a life event from an external source (e.g. Google Tasks sync). */
export async function upsertLifeEvent(
  sb: SupabaseClient,
  data: Omit<LifeEventRow, "id" | "created_at" | "updated_at">,
): Promise<LifeEventRow | null> {
  // Ensure profile exists first
  await ensureUserProfile(sb, data.discord_user_id);

  const { data: row, error } = await sb
    .from("life_events")
    .upsert(data, { onConflict: "discord_user_id,external_uid" })
    .select()
    .single();

  if (error) {
    console.error("Supabase upsertLifeEvent error:", error.message);
    return null;
  }
  return row as LifeEventRow;
}

/** Record a scoring event after task completion. */
export async function recordScoringEvent(
  sb: SupabaseClient,
  data: Omit<ScoringEventRow, "id" | "completed_at">,
): Promise<void> {
  const { error } = await sb.from("scoring_events").insert(data);
  if (error) console.error("Supabase recordScoringEvent error:", error.message);
}

/** Update user_profiles after a completion (points, streak). */
export async function updateUserProfile(
  sb: SupabaseClient,
  discordUserId: string,
  updates: {
    totalPoints: number;
    currentStreak: number;
    longestStreak: number;
    lastCompletionDate: string;  // YYYY-MM-DD
  },
): Promise<void> {
  const { error } = await sb
    .from("user_profiles")
    .update({
      total_points: updates.totalPoints,
      current_streak: updates.currentStreak,
      longest_streak: updates.longestStreak,
      last_completion_date: updates.lastCompletionDate,
    })
    .eq("discord_user_id", discordUserId);
  if (error) console.error("Supabase updateUserProfile error:", error.message);
}

/** Upsert category stats (EMA update). */
export async function upsertCategoryStats(
  sb: SupabaseClient,
  data: Omit<CategoryStatsRow, "updated_at">,
): Promise<void> {
  const { error } = await sb
    .from("category_stats")
    .upsert(data, { onConflict: "discord_user_id,category" });
  if (error) console.error("Supabase upsertCategoryStats error:", error.message);
}

/** Unlock an achievement (no-op if already unlocked due to PK constraint). */
export async function unlockAchievement(
  sb: SupabaseClient,
  discordUserId: string,
  achievementId: string,
): Promise<boolean> {
  const { error } = await sb
    .from("achievements")
    .insert({ discord_user_id: discordUserId, achievement_id: achievementId })
    .select();

  if (error) {
    // Unique constraint violation = already unlocked, not an error
    if (error.code === "23505") return false;
    console.error("Supabase unlockAchievement error:", error.message);
    return false;
  }
  return true;
}

/** Get user profile + stats. Returns null if user doesn't exist yet. */
export async function getUserStats(
  sb: SupabaseClient,
  discordUserId: string,
): Promise<{
  profile: UserProfileRow;
  categoryStats: CategoryStatsRow[];
  achievements: AchievementRow[];
} | null> {
  const [profileRes, statsRes, achievementsRes] = await Promise.all([
    sb.from("user_profiles").select("*").eq("discord_user_id", discordUserId).single(),
    sb.from("category_stats").select("*").eq("discord_user_id", discordUserId),
    sb.from("achievements").select("*").eq("discord_user_id", discordUserId),
  ]);

  if (profileRes.error || !profileRes.data) return null;

  return {
    profile: profileRes.data as UserProfileRow,
    categoryStats: (statsRes.data ?? []) as CategoryStatsRow[],
    achievements: (achievementsRes.data ?? []) as AchievementRow[],
  };
}

/** Get pending life events for leaderboard (all categories or filtered). */
export async function getPendingLifeEvents(
  sb: SupabaseClient,
  discordUserId: string,
  category?: string,
  limit = 100,
): Promise<LifeEventRow[]> {
  let query = sb
    .from("life_events")
    .select("*")
    .eq("discord_user_id", discordUserId)
    .eq("completed", false)
    .limit(limit);

  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) {
    console.error("Supabase getPendingLifeEvents error:", error.message);
    return [];
  }
  return (data ?? []) as LifeEventRow[];
}

/** Get recent scoring events for history display. */
export async function getRecentScoringEvents(
  sb: SupabaseClient,
  discordUserId: string,
  limit = 20,
): Promise<ScoringEventRow[]> {
  const { data, error } = await sb
    .from("scoring_events")
    .select("*")
    .eq("discord_user_id", discordUserId)
    .order("completed_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Supabase getRecentScoringEvents error:", error.message);
    return [];
  }
  return (data ?? []) as ScoringEventRow[];
}

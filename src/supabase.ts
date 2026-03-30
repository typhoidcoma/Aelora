import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";

// ============================================================
// Client singleton
// ============================================================

let _client: SupabaseClient | null = null;
let _serviceClient: SupabaseClient | null = null;

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

/**
 * Service-role client that bypasses RLS.
 * Required for server-side quest CRUD where quests.user_id is a Supabase Auth UUID.
 */
export function getServiceRoleClient(config: Config): SupabaseClient {
  if (_serviceClient) return _serviceClient;

  if (!config.supabase?.url || !config.supabase?.serviceRoleKey) {
    throw new Error(
      "Supabase service role not configured. Add supabase.serviceRoleKey to settings.yaml or AELORA_SUPABASE_SERVICE_ROLE_KEY env.",
    );
  }

  _serviceClient = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
  );
  return _serviceClient;
}

/** Returns the service-role client or null if not configured. */
export function tryGetServiceRoleClient(config: Config): SupabaseClient | null {
  try {
    return getServiceRoleClient(config);
  } catch {
    return null;
  }
}

/** Returns the already-initialized service-role client, or null. */
export function getCachedServiceRoleClient(): SupabaseClient | null {
  return _serviceClient;
}

// ============================================================
// Row types (matches 001_scoring_system.sql)
// ============================================================

export type UserProfileRow = {
  discord_user_id: string;
  total_points: number;
  current_streak: number;
  longest_streak: number;
  last_completion_date: string | null; // YYYY-MM-DD
  google_task_list_id: string | null; // Per-user Google Task list ID
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
  due_date: string | null; // ISO 8601
  completed: boolean;
  completed_at: string | null;
  estimated_minutes: number | null;
  size_label: "micro" | "small" | "medium" | "large" | "epic" | null;
  impact_level: "trivial" | "low" | "moderate" | "high" | "critical" | null;
  irreversible: boolean | null;
  affects_others: boolean | null;
  smeq_estimate: number | null; // 0-150
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
  smeq_actual: number | null; // 0-150
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
// Quest row types
// ============================================================

export type QuestRow = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  category: string;
  quest_type: string;
  target_value: number;
  current_value: number;
  status: string;
  difficulty: string;
  suggested_by: string;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
  is_favorite: boolean;
};

/** Coerce DB null / legacy rows to false so clients can use strict `=== true` for Top 3. */
export function normalizeQuestRow(row: QuestRow): QuestRow {
  return { ...row, is_favorite: row.is_favorite === true };
}

export type QuestLogRow = {
  id: string;
  quest_id: string;
  user_id: string;
  notes: string | null;
  logged_at: string;
};

// ============================================================
// Typed helpers
// ============================================================

/** Ensure a user_profiles row exists (upsert on first use). */
export async function ensureUserProfile(
  sb: SupabaseClient,
  discordUserId: string,
): Promise<void> {
  await sb
    .from("user_profiles")
    .upsert(
      { discord_user_id: discordUserId },
      { onConflict: "discord_user_id", ignoreDuplicates: true },
    );
}

/** Get the user's Google Task list ID (null if not yet created). */
export async function getTaskListId(
  sb: SupabaseClient,
  discordUserId: string,
): Promise<string | null> {
  const { data, error } = await sb
    .from("user_profiles")
    .select("google_task_list_id")
    .eq("discord_user_id", discordUserId)
    .single();
  if (error || !data) return null;
  return (data as { google_task_list_id: string | null }).google_task_list_id;
}

/** Store the user's Google Task list ID after creation. */
export async function setTaskListId(
  sb: SupabaseClient,
  discordUserId: string,
  listId: string,
): Promise<void> {
  await sb
    .from("user_profiles")
    .update({ google_task_list_id: listId })
    .eq("discord_user_id", discordUserId);
}

/** Get the user's Google Calendar ID (null if not yet created). */
export async function getCalendarId(
  sb: SupabaseClient,
  discordUserId: string,
): Promise<string | null> {
  const { data, error } = await sb
    .from("user_profiles")
    .select("google_calendar_id")
    .eq("discord_user_id", discordUserId)
    .single();
  if (error || !data) return null;
  return (data as { google_calendar_id: string | null }).google_calendar_id;
}

/** Store the user's Google Calendar ID after creation. */
export async function setCalendarId(
  sb: SupabaseClient,
  discordUserId: string,
  calendarId: string,
): Promise<void> {
  await sb
    .from("user_profiles")
    .update({ google_calendar_id: calendarId })
    .eq("discord_user_id", discordUserId);
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
    lastCompletionDate: string; // YYYY-MM-DD
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
  if (error)
    console.error("Supabase upsertCategoryStats error:", error.message);
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
    sb
      .from("user_profiles")
      .select("*")
      .eq("discord_user_id", discordUserId)
      .single(),
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

// ============================================================
// Quest CRUD helpers (use service-role client to bypass RLS)
// ============================================================

export type QuestFilters = {
  status?: string;
  category?: string;
  limit?: number;
};

export async function listQuests(
  sb: SupabaseClient,
  userId: string,
  filters: QuestFilters = {},
): Promise<QuestRow[]> {
  let query = sb
    .from("quests")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(filters.limit ?? 50);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.category) query = query.eq("category", filters.category);

  const { data, error } = await query;
  if (error) {
    console.error("Supabase listQuests error:", error.message);
    return [];
  }
  return ((data ?? []) as QuestRow[]).map(normalizeQuestRow);
}

export async function getQuestById(
  sb: SupabaseClient,
  userId: string,
  questId: string,
): Promise<QuestRow | null> {
  const { data, error } = await sb
    .from("quests")
    .select("*")
    .eq("id", questId)
    .eq("user_id", userId)
    .single();
  if (error || !data) return null;
  return normalizeQuestRow(data as QuestRow);
}

export type CreateQuestInput = {
  title: string;
  description?: string | null;
  category?: string;
  quest_type?: string;
  target_value?: number;
  difficulty?: string;
  suggested_by?: string;
};

export type CreateQuestResult =
  | { ok: true; quest: QuestRow }
  | { ok: false; error: string; code?: string };

/** Human-readable Supabase / PostgREST error for logs and tool responses. */
function formatSupabaseError(err: {
  message: string;
  details?: string;
  hint?: string;
  code?: string;
}): string {
  const parts = [err.message, err.details, err.hint].filter(Boolean);
  return parts.join(" | ");
}

/** Values allowed by typical Patyna `quests_category_check` (snake_case). */
export const PATYNA_QUEST_CATEGORIES = [
  "mental_health",
  "fitness",
  "learning",
  "productivity",
  "relationships",
  "mindfulness",
] as const;

export type PatynaQuestCategory = (typeof PATYNA_QUEST_CATEGORIES)[number];

/** Patyna `quests_quest_type_check` — see patyna/src/quests/quest-types.ts */
export const PATYNA_QUEST_TYPES = ["daily", "milestone", "streak"] as const;

export type PatynaQuestType = (typeof PATYNA_QUEST_TYPES)[number];

/** Default when model + settings omit category (errands/shopping fit “getting things done”). */
const DEFAULT_QUEST_CATEGORY_PATYNA: PatynaQuestCategory = "productivity";

/** Matches Patyna app default (`DEFAULT_QUEST_TYPE`); not `boolean` (DB rejects it). */
const DEFAULT_QUEST_TYPE_PATYNA: PatynaQuestType = "daily";

function resolvePatynaQuestType(
  raw: string | undefined | null,
): PatynaQuestType {
  const v = raw != null ? String(raw).trim().toLowerCase() : "";
  if ((PATYNA_QUEST_TYPES as readonly string[]).includes(v))
    return v as PatynaQuestType;
  if (v === "boolean") return "daily";
  if (v === "counter") return "milestone";
  return DEFAULT_QUEST_TYPE_PATYNA;
}

export type CreateQuestOptions = {
  /**
   * When set, used if `input.category` is omitted. Must be one of `PATYNA_QUEST_CATEGORIES`
   * (or your DB’s CHECK list if you changed it).
   */
  defaultCategory?: string;
};

export async function createQuest(
  sb: SupabaseClient,
  userId: string,
  input: CreateQuestInput,
  options?: CreateQuestOptions,
): Promise<CreateQuestResult> {
  // Patyna-style quests tables often mark category, quest_type, status, difficulty,
  // target_value, current_value, suggested_by (and sometimes description) as NOT NULL.
  // Sending only user_id + title triggers Postgres 23502 (NOT NULL violation).
  const description =
    input.description !== undefined &&
    input.description !== null &&
    String(input.description).trim() !== ""
      ? input.description
      : "";

  const explicitCat =
    input.category != null && String(input.category).trim() !== ""
      ? String(input.category).trim()
      : null;
  const configCat =
    options?.defaultCategory != null &&
    String(options.defaultCategory).trim() !== ""
      ? String(options.defaultCategory).trim()
      : null;
  const categoryToSend =
    explicitCat ?? configCat ?? DEFAULT_QUEST_CATEGORY_PATYNA;

  const payload: Record<string, unknown> = {
    user_id: userId,
    title: input.title,
    description,
    category: categoryToSend,
    quest_type: resolvePatynaQuestType(input.quest_type),
    target_value: input.target_value ?? 1,
    current_value: 0,
    status: "active",
    difficulty: input.difficulty ?? "medium",
    suggested_by: input.suggested_by ?? "user",
    is_favorite: false,
  };

  const { data, error } = await sb
    .from("quests")
    .insert(payload)
    .select()
    .single();

  if (error) {
    const msg = formatSupabaseError(error);
    console.error("Supabase createQuest error:", msg, error.code ?? "");
    return { ok: false, error: msg, code: error.code };
  }
  return { ok: true, quest: normalizeQuestRow(data as QuestRow) };
}

export type UpdateQuestInput = {
  title?: string;
  description?: string | null;
  category?: string;
  quest_type?: string;
  target_value?: number;
  current_value?: number;
  status?: string;
  difficulty?: string;
  completed_at?: string | null;
  is_favorite?: boolean;
};

export async function updateQuest(
  sb: SupabaseClient,
  userId: string,
  questId: string,
  patch: UpdateQuestInput,
): Promise<QuestRow | null> {
  const safe: UpdateQuestInput = { ...patch };
  if (
    "is_favorite" in safe &&
    safe.is_favorite !== undefined &&
    typeof safe.is_favorite !== "boolean"
  ) {
    delete (safe as Record<string, unknown>).is_favorite;
  }

  const { data, error } = await sb
    .from("quests")
    .update(safe)
    .eq("id", questId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    console.error("Supabase updateQuest error:", error.message);
    return null;
  }
  return normalizeQuestRow(data as QuestRow);
}

export async function deleteQuest(
  sb: SupabaseClient,
  userId: string,
  questId: string,
): Promise<boolean> {
  const { error, count } = await sb
    .from("quests")
    .delete({ count: "exact" })
    .eq("id", questId)
    .eq("user_id", userId);

  if (error) {
    console.error("Supabase deleteQuest error:", error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

export async function appendQuestLog(
  sb: SupabaseClient,
  userId: string,
  questId: string,
  notes: string,
): Promise<QuestLogRow | null> {
  const { data, error } = await sb
    .from("quest_logs")
    .insert({ quest_id: questId, user_id: userId, notes })
    .select()
    .single();

  if (error) {
    console.error("Supabase appendQuestLog error:", error.message);
    return null;
  }
  return data as QuestLogRow;
}

export async function getQuestLogs(
  sb: SupabaseClient,
  questId: string,
  limit = 20,
): Promise<QuestLogRow[]> {
  const { data, error } = await sb
    .from("quest_logs")
    .select("*")
    .eq("quest_id", questId)
    .order("logged_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Supabase getQuestLogs error:", error.message);
    return [];
  }
  return (data ?? []) as QuestLogRow[];
}

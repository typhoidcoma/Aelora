import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";

// ============================================================
// Client singleton
// ============================================================

let _client: SupabaseClient | null = null;

/** Service-role client for Patyna `quests` only; bypasses RLS. Set via `initQuestsSupabaseClient`. */
let _questsClient: SupabaseClient | null = null;

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
 * When `supabase.serviceRoleKey` is set in config, initializes a second client for quest writes.
 * Call once at startup after `tryGetSupabaseClient` (needs URL + anon for the main client).
 */
export function initQuestsSupabaseClient(config: Config): void {
  _questsClient = null;
  const url = config.supabase?.url?.trim();
  const key = config.supabase?.serviceRoleKey?.trim();
  if (!url || !key) return;
  _questsClient = createClient(url, key);
  console.log("Supabase: service-role client enabled for Patyna quests (server writes bypass RLS)");
}

/**
 * Client for `quests` / `quest_logs`: service role if configured, otherwise anon (RLS applies).
 */
export function getQuestsSupabaseClient(): SupabaseClient | null {
  if (_questsClient) return _questsClient;
  return _client;
}

/** True when `supabase.serviceRoleKey` was set and quest writes use the service-role client (bypasses RLS). */
export function hasQuestsServiceRoleClient(): boolean {
  return _questsClient != null;
}

// ============================================================
// Typed helpers
// ============================================================

/** Ensure a user_profiles row exists (upsert on first use). */
export async function ensureUserProfile(
  sb: SupabaseClient,
  discordUserId: string,
): Promise<void> {
  const { error } = await sb.from("user_profiles").upsert(
    { discord_user_id: discordUserId },
    { onConflict: "discord_user_id", ignoreDuplicates: true },
  );
  if (error) {
    console.warn(`Supabase: ensureUserProfile failed for ${discordUserId}: ${error.message}`);
  }
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
  if (error) {
    console.warn(`Supabase: getTaskListId failed for ${discordUserId}: ${error.message}`);
    return null;
  }
  if (!data) return null;
  return (data as { google_task_list_id: string | null }).google_task_list_id;
}

/** Store the user's Google Task list ID after creation. */
export async function setTaskListId(
  sb: SupabaseClient,
  discordUserId: string,
  listId: string,
): Promise<void> {
  const { error } = await sb
    .from("user_profiles")
    .update({ google_task_list_id: listId })
    .eq("discord_user_id", discordUserId);
  if (error) {
    console.warn(`Supabase: setTaskListId failed for ${discordUserId}: ${error.message}`);
  }
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
  if (error) {
    console.warn(`Supabase: getCalendarId failed for ${discordUserId}: ${error.message}`);
    return null;
  }
  if (!data) return null;
  return (data as { google_calendar_id: string | null }).google_calendar_id;
}

/** Store the user's Google Calendar ID after creation. */
export async function setCalendarId(
  sb: SupabaseClient,
  discordUserId: string,
  calendarId: string,
): Promise<void> {
  const { error } = await sb
    .from("user_profiles")
    .update({ google_calendar_id: calendarId })
    .eq("discord_user_id", discordUserId);
  if (error) {
    console.warn(`Supabase: setCalendarId failed for ${discordUserId}: ${error.message}`);
  }
}

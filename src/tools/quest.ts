import type { SupabaseClient } from "@supabase/supabase-js";
import { defineTool, param } from "./types.js";
import { getQuestsSupabaseClient } from "../supabase.js";
import { broadcastEvent } from "../logger.js";

/**
 * Patyna `quests` / `quest_logs` (Supabase). Shared by the `quest` tool and `/api/quests`.
 *
 * Aelora reaches Supabase over HTTPS from this process. Quest routes and the `quest` tool use
 * `getQuestsSupabaseClient()`: **service role** when `supabase.serviceRoleKey` is set (bypasses RLS),
 * otherwise the **anon** client (RLS applies). Scoring tables still use the anon client only.
 */

export const QUEST_TABLE = "quests";
export const QUEST_LOG_TABLE = "quest_logs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type QuestRow = {
  id: string;
  user_id: string | null;
  title: string;
  description: string | null;
  category: string;
  quest_type: string;
  target_value: number;
  current_value: number;
  status: string;
  difficulty: string;
  suggested_by: string;
  created_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  is_favorite: boolean;
  started_at: string | null;
};

type QuestInsert = {
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
  is_favorite: boolean;
};

/** Must satisfy `quests_category_check` (see Supabase migration). */
const DEFAULT_CATEGORY = "productivity";
const ALLOWED_CATEGORIES = new Set(["productivity", "health", "finance", "social", "work"]);

const CATEGORY_SYNONYMS: Record<string, string> = {
  errands: "productivity",
  chores: "productivity",
  tasks: "productivity",
  todo: "productivity",
  organize: "productivity",
  planning: "productivity",
  shopping: "productivity",
  cleaning: "productivity",
  admin: "productivity",
  money: "finance",
  budget: "finance",
  saving: "finance",
  investing: "finance",
  bills: "finance",
  taxes: "finance",
  debt: "finance",
  banking: "finance",
  exercise: "health",
  fitness: "health",
  wellness: "health",
  medical: "health",
  doctor: "health",
  therapy: "health",
  diet: "health",
  sleep: "health",
  nutrition: "health",
  mental: "health",
  mindfulness: "health",
  meditation: "health",
  selfcare: "health",
  career: "work",
  job: "work",
  professional: "work",
  office: "work",
  project: "work",
  meeting: "work",
  study: "work",
  learning: "work",
  education: "work",
  school: "work",
  training: "work",
  friends: "social",
  family: "social",
  relationships: "social",
  dating: "social",
  community: "social",
  networking: "social",
  party: "social",
  hangout: "social",
  volunteer: "social",
};

/** Keyword → category mapping for fuzzy substring matching. */
const CATEGORY_KEYWORDS: Record<string, string> = {
  gym: "health",
  run: "health",
  walk: "health",
  cook: "health",
  water: "health",
  weight: "health",
  vitamin: "health",
  dentist: "health",
  pay: "finance",
  rent: "finance",
  loan: "finance",
  invest: "finance",
  save: "finance",
  earn: "work",
  hire: "work",
  interview: "work",
  resume: "work",
  deadline: "work",
  homework: "work",
  exam: "work",
  call: "social",
  visit: "social",
  gift: "social",
  birthday: "social",
  clean: "productivity",
  fix: "productivity",
  buy: "productivity",
  mail: "productivity",
  laundry: "productivity",
  grocery: "productivity",
};

/** Coerce legacy/invalid values so inserts never hit `quests_category_check`. */
function normalizeCategory(raw: string | undefined): string {
  const c = (raw ?? "").trim().toLowerCase();
  if (!c) return DEFAULT_CATEGORY;
  if (ALLOWED_CATEGORIES.has(c)) return c;
  if (c in CATEGORY_SYNONYMS) return CATEGORY_SYNONYMS[c];

  // Check if any synonym is a substring of the input or vice versa
  for (const [syn, cat] of Object.entries(CATEGORY_SYNONYMS)) {
    if (c.includes(syn) || syn.includes(c)) return cat;
  }

  // Check keyword matches against the input
  for (const [kw, cat] of Object.entries(CATEGORY_KEYWORDS)) {
    if (c.includes(kw)) return cat;
  }

  // Check if any allowed category is a substring of the input
  for (const cat of ALLOWED_CATEGORIES) {
    if (c.includes(cat)) return cat;
  }

  return DEFAULT_CATEGORY;
}

/** Must satisfy `quests.quest_type` CHECK: daily | milestone | streak (not legacy "task"). */
const DEFAULT_QUEST_TYPE = "daily";
const ALLOWED_QUEST_TYPES = new Set(["daily", "milestone", "streak"]);

/** Coerce legacy/invalid values so inserts never hit `quests_quest_type_check`. */
function normalizeQuestType(raw: string | undefined): string {
  const t = (raw ?? "").trim().toLowerCase();
  if (ALLOWED_QUEST_TYPES.has(t)) return t;
  if (t === "task") return "daily";
  return DEFAULT_QUEST_TYPE;
}

const DEFAULT_STATUS_ACTIVE = "active";
const DEFAULT_DIFFICULTY = "medium";
const DEFAULT_SUGGESTED_BY = "wendy";
const DEFAULT_TARGET = 1;
const DEFAULT_CURRENT = 0;
export const STATUS_COMPLETED = "completed";

export function isValidUuid(id: string): boolean {
  return UUID_RE.test(id.trim());
}

/** Shape returned when a Supabase/PostgREST call fails (for APIs and tools). */
export type QuestDbFailure = {
  ok: false;
  error: string;
  code?: string;
  hint?: string;
  details?: string;
  /** Suggested HTTP status for REST handlers */
  httpStatus: number;
};

type OkCreate = { ok: true; row: QuestRow };
type OkComplete = {
  ok: true;
  row: QuestRow;
  logInserted: boolean;
  notesSaveError?: string;
};
type OkList = { ok: true; rows: QuestRow[] };

function isPostgrestLike(
  e: unknown,
): e is { message: string; code?: string; details?: string; hint?: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    "message" in e &&
    typeof (e as { message: unknown }).message === "string"
  );
}

/**
 * Map PostgREST / Postgres errors to a stable client-facing message and HTTP status.
 */
export function questDbFailureFromSupabaseError(err: unknown, context: string): QuestDbFailure {
  if (isPostgrestLike(err)) {
    const code = err.code ?? "";
    const raw = err.message;
    const hint = err.hint?.trim() || undefined;
    const details = err.details?.trim() || undefined;
    const lower = raw.toLowerCase();

    let httpStatus = 502;
    let error = raw;

    if (
      lower.includes("row-level security") ||
      lower.includes("violates row-level security") ||
      code === "42501" ||
      lower.includes("permission denied for table")
    ) {
      httpStatus = 403;
      error =
        "Supabase rejected this write (row-level security or permissions). " +
        "For server-side Patyna quest APIs, set supabase.serviceRoleKey in settings.yaml so writes bypass RLS, " +
        "or relax RLS for `quests` / `quest_logs` for your deployment.";
    } else if (
      lower.includes("relation") &&
      lower.includes("does not exist") &&
      (lower.includes("quests") || lower.includes("quest_logs"))
    ) {
      httpStatus = 503;
      error =
        "Quest tables are missing or not exposed to the API. Create or publish the `quests` / `quest_logs` tables in this Supabase project.";
    } else if (code === "23505" || lower.includes("duplicate key")) {
      httpStatus = 409;
    } else if (code === "23503" || lower.includes("foreign key")) {
      httpStatus = 400;
      error =
        "Insert rejected: user_id must exist in the referenced table (e.g. public.profiles). " +
        "Ensure a profile row exists for this Supabase Auth user, or align FKs with auth.users.";
    } else if (code === "23514" || lower.includes("violates check constraint")) {
      httpStatus = 400;
      error =
        raw +
        " — Check `quests` constraints: category, quest_type (daily|milestone|streak), difficulty, suggested_by, status.";
    } else if (
      lower.includes("jwt") ||
      lower.includes("invalid api key") ||
      lower.includes("invalid authentication credentials")
    ) {
      httpStatus = 503;
      error = "Supabase rejected the API key. Check `supabase.anonKey` in settings.yaml.";
    } else if (
      lower.includes("failed to fetch") ||
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("socket hang up")
    ) {
      httpStatus = 502;
      error = `Could not reach Supabase (${context}). Check network, project URL, and that the project is running.`;
    } else if (/^PGRST\d+$/.test(code) || /^\d{5}$/.test(code)) {
      httpStatus = 400;
    }

    return {
      ok: false,
      error,
      code: code || undefined,
      hint,
      details,
      httpStatus,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: `Unexpected error (${context}): ${message}`,
    httpStatus: 502,
  };
}

export async function probeQuestsTable(
  sb: SupabaseClient,
): Promise<{ ok: true } | QuestDbFailure> {
  const { error } = await sb.from(QUEST_TABLE).select("id").limit(1);
  if (error) {
    const f = questDbFailureFromSupabaseError(error, "probe quests");
    console.error("quests: probeQuestsTable failed:", f.code, f.error);
    return f;
  }
  return { ok: true };
}

export type CreateQuestInput = {
  title: string;
  description?: string;
  category?: string;
  quest_type?: string;
  target_value?: number;
  current_value?: number;
  status?: string;
  difficulty?: string;
  suggested_by?: string;
  is_favorite?: boolean;
};

export async function createQuestRow(
  sb: SupabaseClient,
  userId: string,
  input: CreateQuestInput,
): Promise<OkCreate | QuestDbFailure> {
  const insert: QuestInsert = {
    user_id: userId,
    title: input.title.trim(),
    description: input.description?.trim() ?? null,
    category: normalizeCategory(input.category),
    quest_type: normalizeQuestType(input.quest_type),
    target_value: input.target_value ?? DEFAULT_TARGET,
    current_value: input.current_value ?? DEFAULT_CURRENT,
    status: (input.status ?? DEFAULT_STATUS_ACTIVE).trim(),
    difficulty: (input.difficulty ?? DEFAULT_DIFFICULTY).trim(),
    suggested_by: (input.suggested_by ?? DEFAULT_SUGGESTED_BY).trim(),
    is_favorite: input.is_favorite ?? false,
  };

  if (insert.target_value < 0) {
    return {
      ok: false,
      error: "target_value must be non-negative.",
      httpStatus: 400,
    };
  }
  if (insert.current_value < 0) {
    return {
      ok: false,
      error: "current_value must be non-negative.",
      httpStatus: 400,
    };
  }

  // Ensure a profile row exists for this user so the FK on quests.user_id is satisfied.
  const { error: profileErr } = await sb
    .from("profiles")
    .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });
  if (profileErr) {
    console.warn("quests: profile upsert warning (non-fatal):", profileErr.message);
  }

  const { data, error } = await sb
    .from(QUEST_TABLE)
    .insert(insert)
    .select()
    .single();

  if (error) {
    const f = questDbFailureFromSupabaseError(error, "createQuest");
    console.error("quests: createQuestRow:", f.code, f.error);
    return f;
  }
  const row = data as QuestRow;
  broadcastEvent("quest", { action: "created", quest: row });
  return { ok: true, row };
}

export async function completeQuestRow(
  sb: SupabaseClient,
  userId: string,
  questId: string,
  options?: { notes?: string | null },
): Promise<OkComplete | QuestDbFailure> {
  const { data: existing, error: fetchErr } = await sb
    .from(QUEST_TABLE)
    .select("id,target_value,current_value,status")
    .eq("id", questId)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) {
    const f = questDbFailureFromSupabaseError(fetchErr, "completeQuest(fetch)");
    console.error("quests: completeQuestRow fetch:", f.code, f.error);
    return f;
  }
  if (!existing) {
    return {
      ok: false,
      error: "Quest not found for this user_id.",
      httpStatus: 404,
    };
  }

  const target = (existing as { target_value: number }).target_value;
  const now = new Date().toISOString();

  const { data, error } = await sb
    .from(QUEST_TABLE)
    .update({
      status: STATUS_COMPLETED,
      completed_at: now,
      updated_at: now,
      current_value: target,
    })
    .eq("id", questId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    const f = questDbFailureFromSupabaseError(error, "completeQuest(update)");
    console.error("quests: completeQuestRow update:", f.code, f.error);
    return f;
  }

  const row = data as QuestRow;
  const trimmedNotes = options?.notes?.trim() ?? "";
  let logInserted = false;

  let notesSaveError: string | undefined;

  if (trimmedNotes.length > 0) {
    const { error: logErr } = await sb.from(QUEST_LOG_TABLE).insert({
      quest_id: questId,
      user_id: userId,
      notes: trimmedNotes,
      logged_at: now,
    });
    if (logErr) {
      const nf = questDbFailureFromSupabaseError(logErr, "quest_logs insert");
      notesSaveError = nf.error;
      console.error("quests: quest_logs insert failed after complete:", nf.code, nf.error);
    } else {
      logInserted = true;
    }
  }

  broadcastEvent("quest", { action: "completed", quest: row });
  return { ok: true, row, logInserted, ...(notesSaveError ? { notesSaveError } : {}) };
}

export async function listQuestRows(
  sb: SupabaseClient,
  userId: string,
  options: { status?: string; limit: number },
): Promise<OkList | QuestDbFailure> {
  let q = sb
    .from(QUEST_TABLE)
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(options.limit, 1), 100));

  if (options.status && options.status !== "all") {
    q = q.eq("status", options.status);
  }

  const { data, error } = await q;

  if (error) {
    const f = questDbFailureFromSupabaseError(error, "listQuests");
    console.error("quests: listQuestRows:", f.code, f.error);
    return f;
  }
  return { ok: true, rows: (data ?? []) as QuestRow[] };
}

type OkUpdate = { ok: true; row: QuestRow };

export type UpdateQuestInput = {
  title?: string;
  description?: string | null;
  category?: string;
  quest_type?: string;
  target_value?: number;
  current_value?: number;
  status?: string;
  difficulty?: string;
  suggested_by?: string;
  is_favorite?: boolean;
};

export async function updateQuestRow(
  sb: SupabaseClient,
  userId: string,
  questId: string,
  input: UpdateQuestInput,
): Promise<OkUpdate | QuestDbFailure> {
  const { data: existing, error: fetchErr } = await sb
    .from(QUEST_TABLE)
    .select("id")
    .eq("id", questId)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) {
    const f = questDbFailureFromSupabaseError(fetchErr, "updateQuest(fetch)");
    console.error("quests: updateQuestRow fetch:", f.code, f.error);
    return f;
  }
  if (!existing) {
    return { ok: false, error: "Quest not found for this user_id.", httpStatus: 404 };
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) updates.title = input.title.trim();
  if (input.description !== undefined) updates.description = input.description?.trim() ?? null;
  if (input.category !== undefined) updates.category = normalizeCategory(input.category);
  if (input.quest_type !== undefined) updates.quest_type = normalizeQuestType(input.quest_type);
  if (input.target_value !== undefined) updates.target_value = input.target_value;
  if (input.current_value !== undefined) updates.current_value = input.current_value;
  if (input.status !== undefined) updates.status = input.status.trim();
  if (input.difficulty !== undefined) updates.difficulty = input.difficulty.trim();
  if (input.suggested_by !== undefined) updates.suggested_by = input.suggested_by.trim();
  if (input.is_favorite !== undefined) updates.is_favorite = input.is_favorite;

  if (Object.keys(updates).length <= 1) {
    return { ok: false, error: "No fields to update.", httpStatus: 400 };
  }

  const { data, error } = await sb
    .from(QUEST_TABLE)
    .update(updates)
    .eq("id", questId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    const f = questDbFailureFromSupabaseError(error, "updateQuest(update)");
    console.error("quests: updateQuestRow update:", f.code, f.error);
    return f;
  }
  const row = data as QuestRow;
  broadcastEvent("quest", { action: "updated", quest: row });
  return { ok: true, row };
}

type OkDelete = { ok: true; id: string; title: string };

export async function deleteQuestRow(
  sb: SupabaseClient,
  userId: string,
  questId: string,
): Promise<OkDelete | QuestDbFailure> {
  // Fetch first to confirm existence and get title for confirmation message
  const { data: existing, error: fetchErr } = await sb
    .from(QUEST_TABLE)
    .select("id,title")
    .eq("id", questId)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) {
    const f = questDbFailureFromSupabaseError(fetchErr, "deleteQuest(fetch)");
    console.error("quests: deleteQuestRow fetch:", f.code, f.error);
    return f;
  }
  if (!existing) {
    return { ok: false, error: "Quest not found for this user_id.", httpStatus: 404 };
  }

  // Delete associated quest_logs first (foreign key)
  await sb.from(QUEST_LOG_TABLE).delete().eq("quest_id", questId);

  const { error } = await sb
    .from(QUEST_TABLE)
    .delete()
    .eq("id", questId)
    .eq("user_id", userId);

  if (error) {
    const f = questDbFailureFromSupabaseError(error, "deleteQuest(delete)");
    console.error("quests: deleteQuestRow delete:", f.code, f.error);
    return f;
  }
  const title = (existing as { title: string }).title;
  broadcastEvent("quest", { action: "deleted", id: questId, title });
  return { ok: true, id: questId, title };
}

type OkFavorite = { ok: true; row: QuestRow };

export async function setQuestFavoriteRow(
  sb: SupabaseClient,
  userId: string,
  questId: string,
  isFavorite: boolean,
): Promise<OkFavorite | QuestDbFailure> {
  const { data: existing, error: fetchErr } = await sb
    .from(QUEST_TABLE)
    .select("id")
    .eq("id", questId)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) {
    const f = questDbFailureFromSupabaseError(fetchErr, "setQuestFavorite(fetch)");
    console.error("quests: setQuestFavoriteRow fetch:", f.code, f.error);
    return f;
  }
  if (!existing) {
    return {
      ok: false,
      error: "Quest not found for this user_id.",
      httpStatus: 404,
    };
  }

  const now = new Date().toISOString();
  const { data, error } = await sb
    .from(QUEST_TABLE)
    .update({
      is_favorite: isFavorite,
      updated_at: now,
    })
    .eq("id", questId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    const f = questDbFailureFromSupabaseError(error, "setQuestFavorite(update)");
    console.error("quests: setQuestFavoriteRow update:", f.code, f.error);
    return f;
  }
  const row = data as QuestRow;
  broadcastEvent("quest", { action: "updated", quest: row });
  return { ok: true, row };
}

function sbError(prefix: string, message: string): string {
  return `Error: ${prefix}: ${message}`;
}

function formatQuestFailure(prefix: string, f: QuestDbFailure): string {
  const parts = [f.error];
  if (f.details) parts.push(`Details: ${f.details}`);
  if (f.hint) parts.push(`Hint: ${f.hint}`);
  if (f.code) parts.push(`Code: ${f.code}`);
  return sbError(prefix, parts.join(" "));
}

function formatQuestLine(q: QuestRow, index: number): string {
  const done = q.status === STATUS_COMPLETED || q.completed_at;
  const mark = done ? "[x]" : "[ ]";
  let line = `${index + 1}. ${mark} ${q.title} (id: ${q.id})`;
  line += `\n   status=${q.status} progress=${q.current_value}/${q.target_value}`;
  if (q.description) line += `\n   ${q.description.slice(0, 120)}${q.description.length > 120 ? "…" : ""}`;
  return line;
}

export default defineTool({
  name: "quest",
  description:
    "Personal quests in Supabase (table `quests`). The user_id is automatically resolved from the chat session when available (e.g. Patyna frontend). " +
    "For team or project work, use Linear instead. Never say you created or completed a quest unless this tool returned success.\n\n" +
    "Actions: create, complete, list, update, delete, set_favorite.\n\n" +
    "**Creating quests:** Before creating, ask follow-up questions to make the quest as detailed and useful as possible. " +
    "Ask about: what success looks like (to set target_value and description), how hard it is (difficulty), " +
    "whether it's a one-off or recurring (quest_type: daily/milestone/streak), and any relevant category. " +
    "Craft a clear, motivating title and a rich description from the conversation. " +
    "Only skip follow-ups if the user is clearly in a hurry or gave enough detail already.\n\n" +
    "**Updating quests:** Use update to change any field — title, description, category, difficulty, quest_type, target_value, current_value, status, suggested_by, is_favorite. " +
    "Only the fields you pass will be changed.\n\n" +
    "**Deleting quests:** Use delete to permanently remove a quest and its logs. Confirm with the user before deleting.",

  params: {
    action: param.enum(
      "Action: create, complete, list, update, delete, or set_favorite.",
      ["create", "complete", "list", "update", "delete", "set_favorite"] as const,
      { required: true },
    ),
    user_id: param.string(
      "Supabase Auth user UUID. Optional when the chat session already provides a userId (e.g. Patyna frontend). Only pass this to override the session user.",
    ),
    title: param.string("Quest title. Required for create.", { maxLength: 500 }),
    description: param.string("Optional description for create.", { maxLength: 4000 }),
    quest_id: param.string("Quest row UUID. Required for complete, update, delete, and set_favorite.", {}),
    notes: param.string(
      "Optional completion notes for complete. When non-empty, a row is written to `quest_logs`.",
      { maxLength: 8000 },
    ),
    category: param.string("Optional category for create (default: productivity; must be productivity | health | finance | social | work).", { maxLength: 200 }),
    quest_type: param.string(
      "Optional quest_type for create (default: daily; must be daily | milestone | streak).",
      { maxLength: 200 },
    ),
    difficulty: param.string("Optional difficulty for create (default: medium).", { maxLength: 100 }),
    suggested_by: param.string("Optional suggested_by for create (default: wendy).", { maxLength: 200 }),
    target_value: param.number("Optional target_value for create (default: 1).", { minimum: 0 }),
    current_value: param.number("Optional current_value for create (default: 0).", { minimum: 0 }),
    status: param.string(
      "For create: initial status (default: active). For list: filter by this status, or omit to list all.",
      { maxLength: 100 },
    ),
    is_favorite: param.boolean("For create: mark as favorite. For set_favorite: the new favorite state (required)."),
    limit: param.number("For list only: max rows (1–100, default 30).", { minimum: 1, maximum: 100 }),
  },

  handler: async (
    {
      action,
      user_id,
      title,
      description,
      quest_id,
      notes,
      category,
      quest_type,
      difficulty,
      suggested_by,
      target_value,
      current_value,
      status,
      is_favorite,
      limit,
    },
    ctx,
  ) => {
    const sb = getQuestsSupabaseClient();
    if (!sb) {
      return (
        "Error: Supabase is not configured or the client is not initialized yet. " +
        "Add supabase.url and supabase.anonKey to settings.yaml and restart Aelora. " +
        "If inserts fail with RLS/permission errors, add supabase.serviceRoleKey (server-only). " +
        "GET /api/supabase/status reports connectivity to the `quests` table."
      );
    }

    // Resolve user ID: explicit param > ctx.userId (from chat session) > error
    const rawUid = (user_id ?? ctx.userId ?? "").trim();
    if (!isValidUuid(rawUid)) {
      return "Error: user_id must be a valid UUID. Pass it explicitly or ensure the chat session provides a userId.";
    }
    const uid = rawUid;

    switch (action) {
      case "create": {
        if (!title?.trim()) {
          return "Error: title is required for create.";
        }
        const result = await createQuestRow(sb, uid, {
          title: title as string,
          description: description as string | undefined,
          category: category as string | undefined,
          quest_type: quest_type as string | undefined,
          target_value: target_value as number | undefined,
          current_value: current_value as number | undefined,
          status: status as string | undefined,
          difficulty: difficulty as string | undefined,
          suggested_by: suggested_by as string | undefined,
          is_favorite: is_favorite as boolean | undefined,
        });
        if (!result.ok) {
          return formatQuestFailure("createQuest", result);
        }
        const r = result.row;
        return {
          text: `Created quest "${r.title}" (id: ${r.id}, status=${r.status}, ${r.current_value}/${r.target_value}).`,
          data: { action: "create", quest: r },
        };
      }

      case "complete": {
        const qid = (quest_id ?? "").trim();
        if (!qid) {
          return "Error: quest_id is required for complete.";
        }
        if (!isValidUuid(qid)) {
          return "Error: quest_id must be a valid UUID.";
        }
        const result = await completeQuestRow(sb, uid, qid, {
          notes: notes as string | undefined,
        });
        if (!result.ok) {
          return formatQuestFailure("completeQuest", result);
        }
        const r = result.row;
        let text = `Completed quest "${r.title}" (id: ${r.id}).`;
        if (result.notesSaveError) {
          text += ` Warning: completion notes were not saved (${result.notesSaveError}).`;
        }
        return {
          text,
          data: {
            action: "complete",
            quest: r,
            logInserted: result.logInserted,
            ...(result.notesSaveError ? { notesSaveError: result.notesSaveError } : {}),
          },
        };
      }

      case "list": {
        const lim = limit ?? 30;
        const statusFilter =
          status !== undefined && status !== null && String(status).trim() !== ""
            ? String(status).trim()
            : "all";
        const result = await listQuestRows(sb, uid, { status: statusFilter, limit: lim });
        if (!result.ok) {
          return formatQuestFailure("listQuests", result);
        }
        const rows = result.rows;
        if (rows.length === 0) {
          return {
            text: "No quests found for this user_id.",
            data: { action: "list", count: 0, quests: [] },
          };
        }
        const lines = rows.map((q, i) => formatQuestLine(q, i));
        return {
          text: `Quests (${rows.length}):\n\n${lines.join("\n\n")}`,
          data: { action: "list", count: rows.length, quests: rows },
        };
      }

      case "update": {
        const qid = (quest_id ?? "").trim();
        if (!qid) {
          return "Error: quest_id is required for update.";
        }
        if (!isValidUuid(qid)) {
          return "Error: quest_id must be a valid UUID.";
        }
        const result = await updateQuestRow(sb, uid, qid, {
          title: title as string | undefined,
          description: description as string | undefined,
          category: category as string | undefined,
          quest_type: quest_type as string | undefined,
          target_value: target_value as number | undefined,
          current_value: current_value as number | undefined,
          status: status as string | undefined,
          difficulty: difficulty as string | undefined,
          suggested_by: suggested_by as string | undefined,
          is_favorite: is_favorite as boolean | undefined,
        });
        if (!result.ok) {
          return formatQuestFailure("updateQuest", result);
        }
        const r = result.row;
        return {
          text: `Updated quest "${r.title}" (id: ${r.id}, status=${r.status}, ${r.current_value}/${r.target_value}).`,
          data: { action: "update", quest: r },
        };
      }

      case "delete": {
        const qid = (quest_id ?? "").trim();
        if (!qid) {
          return "Error: quest_id is required for delete.";
        }
        if (!isValidUuid(qid)) {
          return "Error: quest_id must be a valid UUID.";
        }
        const result = await deleteQuestRow(sb, uid, qid);
        if (!result.ok) {
          return formatQuestFailure("deleteQuest", result);
        }
        return {
          text: `Deleted quest "${result.title}" (id: ${result.id}) and its associated logs.`,
          data: { action: "delete", id: result.id, title: result.title },
        };
      }

      case "set_favorite": {
        const qid = (quest_id ?? "").trim();
        if (!qid) {
          return "Error: quest_id is required for set_favorite.";
        }
        if (!isValidUuid(qid)) {
          return "Error: quest_id must be a valid UUID.";
        }
        if (is_favorite === undefined || is_favorite === null) {
          return "Error: is_favorite (boolean) is required for set_favorite.";
        }
        const result = await setQuestFavoriteRow(sb, uid, qid, is_favorite as boolean);
        if (!result.ok) {
          return formatQuestFailure("setQuestFavorite", result);
        }
        const r = result.row;
        return {
          text: `Quest "${r.title}" ${r.is_favorite ? "marked as favorite" : "unmarked as favorite"}.`,
          data: { action: "set_favorite", quest: r },
        };
      }

      default:
        return `Error: unknown action "${String(action)}". Use create, complete, list, update, delete, or set_favorite.`;
    }
  },
});

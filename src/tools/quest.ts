import { defineTool, param } from "./types.js";
import { getCachedSupabaseClient } from "../supabase.js";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// Patyna `quests` table (Supabase). Defaults align with NOT NULL columns.
// ============================================================

const QUEST_TABLE = "quests";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type QuestRow = {
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

const DEFAULT_CATEGORY = "general";
const DEFAULT_QUEST_TYPE = "task";
const DEFAULT_STATUS_ACTIVE = "active";
const DEFAULT_DIFFICULTY = "medium";
const DEFAULT_SUGGESTED_BY = "wendy";
const DEFAULT_TARGET = 1;
const DEFAULT_CURRENT = 0;
const STATUS_COMPLETED = "completed";

function isValidUuid(id: string): boolean {
  return UUID_RE.test(id.trim());
}

function sbError(prefix: string, message: string): string {
  return `Error: ${prefix}: ${message}`;
}

async function createQuest(
  sb: SupabaseClient,
  userId: string,
  input: {
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
  },
): Promise<{ ok: true; row: QuestRow } | { ok: false; error: string }> {
  const insert: QuestInsert = {
    user_id: userId,
    title: input.title.trim(),
    description: input.description?.trim() ?? null,
    category: (input.category ?? DEFAULT_CATEGORY).trim(),
    quest_type: (input.quest_type ?? DEFAULT_QUEST_TYPE).trim(),
    target_value: input.target_value ?? DEFAULT_TARGET,
    current_value: input.current_value ?? DEFAULT_CURRENT,
    status: (input.status ?? DEFAULT_STATUS_ACTIVE).trim(),
    difficulty: (input.difficulty ?? DEFAULT_DIFFICULTY).trim(),
    suggested_by: (input.suggested_by ?? DEFAULT_SUGGESTED_BY).trim(),
    is_favorite: input.is_favorite ?? false,
  };

  if (insert.target_value < 0) {
    return { ok: false, error: "target_value must be non-negative." };
  }
  if (insert.current_value < 0) {
    return { ok: false, error: "current_value must be non-negative." };
  }

  const { data, error } = await sb
    .from(QUEST_TABLE)
    .insert(insert)
    .select()
    .single();

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, row: data as QuestRow };
}

async function completeQuest(
  sb: SupabaseClient,
  userId: string,
  questId: string,
): Promise<{ ok: true; row: QuestRow } | { ok: false; error: string }> {
  const { data: existing, error: fetchErr } = await sb
    .from(QUEST_TABLE)
    .select("id,target_value,current_value,status")
    .eq("id", questId)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) {
    return { ok: false, error: fetchErr.message };
  }
  if (!existing) {
    return { ok: false, error: "Quest not found for this user_id." };
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
    return { ok: false, error: error.message };
  }
  return { ok: true, row: data as QuestRow };
}

async function listQuests(
  sb: SupabaseClient,
  userId: string,
  options: { status?: string; limit: number },
): Promise<{ ok: true; rows: QuestRow[] } | { ok: false; error: string }> {
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
    return { ok: false, error: error.message };
  }
  return { ok: true, rows: (data ?? []) as QuestRow[] };
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
    "Patyna personal quests in Supabase (table `quests`). Scoped only by Supabase Auth user_id — pass the user's Auth UUID on every call; do not infer from Discord. " +
    "For team or project work, use Linear instead. Never say you created or completed a quest unless this tool returned success. " +
    "Actions: create (needs title), complete (needs quest_id), list (optional status filter). Requires Aelora Supabase to be configured.",

  params: {
    action: param.enum(
      "Action: create a quest, mark one complete, or list quests for the user.",
      ["create", "complete", "list"] as const,
      { required: true },
    ),
    user_id: param.string(
      "Supabase Auth user UUID (from Patyna). Required for every action.",
      { required: true },
    ),
    title: param.string("Quest title. Required for create.", { maxLength: 500 }),
    description: param.string("Optional description for create.", { maxLength: 4000 }),
    quest_id: param.string("Quest row UUID. Required for complete.", {}),
    category: param.string("Optional category for create (default: general).", { maxLength: 200 }),
    quest_type: param.string("Optional quest_type for create (default: task).", { maxLength: 200 }),
    difficulty: param.string("Optional difficulty for create (default: medium).", { maxLength: 100 }),
    suggested_by: param.string("Optional suggested_by for create (default: wendy).", { maxLength: 200 }),
    target_value: param.number("Optional target_value for create (default: 1).", { minimum: 0 }),
    current_value: param.number("Optional current_value for create (default: 0).", { minimum: 0 }),
    status: param.string(
      "For create: initial status (default: active). For list: filter by this status, or omit to list all.",
      { maxLength: 100 },
    ),
    is_favorite: param.boolean("Optional; set true to mark favorite (TOP 3) on create."),
    limit: param.number("For list only: max rows (1–100, default 30).", { minimum: 1, maximum: 100 }),
  },

  handler: async (
    {
      action,
      user_id,
      title,
      description,
      quest_id,
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
  ) => {
    const sb = getCachedSupabaseClient();
    if (!sb) {
      return "Error: Supabase is not configured. Add supabase.url and supabase.anonKey to settings.yaml.";
    }

    const uid = (user_id ?? "").trim();
    if (!isValidUuid(uid)) {
      return "Error: user_id must be a valid UUID (Supabase Auth id).";
    }

    switch (action) {
      case "create": {
        if (!title?.trim()) {
          return "Error: title is required for create.";
        }
        const result = await createQuest(sb, uid, {
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
          return sbError("createQuest", result.error);
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
        const result = await completeQuest(sb, uid, qid);
        if (!result.ok) {
          return sbError("completeQuest", result.error);
        }
        const r = result.row;
        return {
          text: `Completed quest "${r.title}" (id: ${r.id}).`,
          data: { action: "complete", quest: r },
        };
      }

      case "list": {
        const lim = limit ?? 30;
        const statusFilter =
          status !== undefined && status !== null && String(status).trim() !== ""
            ? String(status).trim()
            : "all";
        const result = await listQuests(sb, uid, { status: statusFilter, limit: lim });
        if (!result.ok) {
          return sbError("listQuests", result.error);
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

      default:
        return `Error: unknown action "${String(action)}". Use create, complete, or list.`;
    }
  },
});

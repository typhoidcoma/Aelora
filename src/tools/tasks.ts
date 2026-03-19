import { defineTool, param } from "./types.js";
import { googleFetch, extractGoogleConfig, resetGoogleToken, type GoogleConfig } from "./_google-auth.js";
import { getCachedSupabaseClient, ensureUserProfile, getTaskListId, setTaskListId } from "../supabase.js";
import { getUser } from "../users.js";

const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";

// ============================================================
// Types
// ============================================================

export type TaskItem = {
  uid: string;           // Google Task id
  title: string;
  description?: string;  // Google Tasks "notes"
  completed: boolean;
  priority: "low" | "medium" | "high";  // metadata only (Google Tasks has no priority field)
  dueDate?: string;      // ISO 8601 date (YYYY-MM-DD)
  updatedAt?: string;    // Google Tasks "updated" timestamp
};

export type ScoredTaskItem = TaskItem & {
  score?: number;
  scoreBreakdown?: {
    urgency: number;
    impact: number;
    effort: number;
    context: number;
  };
};

type GoogleTask = {
  id: string;
  title: string;
  notes?: string;
  status: "needsAction" | "completed";
  due?: string;       // RFC 3339 (only date part is meaningful: "2025-03-15T00:00:00.000Z")
  completed?: string; // RFC 3339 timestamp of completion
  updated?: string;   // RFC 3339 timestamp of last update
  position?: string;
};

// ============================================================
// Helpers
// ============================================================

function taskToItem(task: GoogleTask): TaskItem {
  return {
    uid: task.id,
    title: task.title,
    description: task.notes,
    completed: task.status === "completed",
    priority: "medium",  // Google Tasks has no priority; overlaid from Supabase later
    dueDate: task.due ? task.due.slice(0, 10) : undefined,
    updatedAt: task.updated,
  };
}

export function getGoogleConfig(
  toolsConfig: Record<string, Record<string, unknown>> | undefined,
): GoogleConfig {
  const google = toolsConfig?.google as Record<string, unknown> | undefined;
  if (!google?.clientId) {
    throw new Error(
      "Google not configured. Add google.clientId, google.clientSecret, and google.refreshToken to settings.yaml under tools:",
    );
  }
  return {
    clientId: google.clientId as string,
    clientSecret: google.clientSecret as string,
    refreshToken: google.refreshToken as string,
  };
}

// ============================================================
// Per-user task list management
// ============================================================

/** Create a new Google Task list and return its ID. */
export async function createTaskList(
  config: GoogleConfig,
  title: string,
): Promise<string> {
  const res = await googleFetch(
    `${TASKS_BASE}/users/@me/lists`,
    config,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tasks API error creating list (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

// In-memory cache: discordUserId → Promise<taskListId>
// Prevents race conditions (concurrent calls get the same in-flight promise)
// and avoids redundant Supabase queries after first resolution.
const _taskListCache = new Map<string, Promise<string>>();

/**
 * Resolve a user's Google Task list ID.
 * If the user doesn't have one yet, creates it and stores the mapping.
 * Cached per-process to prevent duplicate list creation.
 */
export async function resolveUserTaskList(
  config: GoogleConfig,
  discordUserId: string,
  username?: string,
): Promise<string> {
  const cached = _taskListCache.get(discordUserId);
  if (cached) return cached;

  const promise = _resolveUserTaskListInner(config, discordUserId, username);
  _taskListCache.set(discordUserId, promise);

  // On failure, evict so next call can retry
  promise.catch(() => _taskListCache.delete(discordUserId));

  return promise;
}

async function _resolveUserTaskListInner(
  config: GoogleConfig,
  discordUserId: string,
  username?: string,
): Promise<string> {
  const sb = getCachedSupabaseClient();

  if (sb) {
    await ensureUserProfile(sb, discordUserId);
    const existing = await getTaskListId(sb, discordUserId);
    if (existing) return existing;
  }

  // Create a new task list for this user
  const displayName = username ?? getUser(discordUserId)?.username ?? discordUserId;
  const listTitle = `${displayName}'s Tasks`;
  const listId = await createTaskList(config, listTitle);
  console.log(`Tasks: created list "${listTitle}" (${listId}) for user ${discordUserId}`);

  if (sb) {
    await setTaskListId(sb, discordUserId, listId);
  }

  return listId;
}

// ============================================================
// CRUD operations (exported for use by web.ts and scoring)
// ============================================================

export async function listTasks(
  config: GoogleConfig,
  taskListId: string,
  status: "all" | "pending" | "completed" = "pending",
): Promise<TaskItem[]> {
  const showCompleted = status === "completed" || status === "all";
  const params = new URLSearchParams({
    maxResults: "100",
    showCompleted: String(showCompleted),
    showHidden: String(showCompleted),
  });

  const res = await googleFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks?${params}`,
    config,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tasks API error (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { items?: GoogleTask[] };
  const items = (data.items ?? []).map(taskToItem);

  if (status === "pending") return items.filter((t) => !t.completed);
  if (status === "completed") return items.filter((t) => t.completed);
  return items;
}

export async function getTaskByUid(
  config: GoogleConfig,
  uid: string,
  taskListId: string,
): Promise<TaskItem | null> {
  const res = await googleFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(uid)}`,
    config,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Tasks API error (${res.status})`);
  const task = (await res.json()) as GoogleTask;
  return taskToItem(task);
}

export async function createTask(
  config: GoogleConfig,
  taskListId: string,
  opts: {
    title: string;
    description?: string;
    priority?: string;
    dueDate?: string;
  },
): Promise<TaskItem> {
  const body: Record<string, unknown> = { title: opts.title };
  if (opts.description) body.notes = opts.description;
  if (opts.dueDate) body.due = `${opts.dueDate}T00:00:00.000Z`;

  const res = await googleFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks`,
    config,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Tasks API error (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const task = (await res.json()) as GoogleTask;
  const item = taskToItem(task);
  if (opts.priority && ["low", "medium", "high"].includes(opts.priority)) {
    item.priority = opts.priority as "low" | "medium" | "high";
  }
  return item;
}

export async function completeTask(
  config: GoogleConfig,
  uid: string,
  taskListId: string,
): Promise<TaskItem | null> {
  const res = await googleFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(uid)}`,
    config,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Tasks API error (${res.status})`);
  const task = (await res.json()) as GoogleTask;
  return taskToItem(task);
}

export async function updateTask(
  config: GoogleConfig,
  uid: string,
  updates: {
    title?: string;
    description?: string;
    priority?: string;
    dueDate?: string;
  },
  taskListId: string,
): Promise<TaskItem | null> {
  const patch: Record<string, unknown> = {};
  if (updates.title) patch.title = updates.title;
  if (updates.description !== undefined) patch.notes = updates.description;
  if (updates.dueDate) patch.due = `${updates.dueDate}T00:00:00.000Z`;

  if (Object.keys(patch).length === 0) {
    return getTaskByUid(config, uid, taskListId);
  }

  const res = await googleFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(uid)}`,
    config,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Tasks API error (${res.status})`);

  const task = (await res.json()) as GoogleTask;
  const item = taskToItem(task);
  if (updates.priority && ["low", "medium", "high"].includes(updates.priority)) {
    item.priority = updates.priority as "low" | "medium" | "high";
  }
  return item;
}

export async function deleteTask(
  config: GoogleConfig,
  uid: string,
  taskListId: string,
): Promise<boolean> {
  const res = await googleFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(uid)}`,
    config,
    { method: "DELETE" },
  );
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Tasks API error (${res.status})`);
  return true;
}

// ============================================================
// LLM Tool definition
// ============================================================

export default defineTool({
  name: "tasks",
  description:
    "Manage personal tasks. Each user has their own task list. " +
    "Actions: list, add, complete, update, delete. " +
    "Priority is stored as metadata.",

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  params: {
    action: param.enum(
      "Action to perform.",
      ["list", "add", "complete", "update", "delete"] as const,
      { required: true },
    ),
    title: param.string("Task title. Required for add."),
    description: param.string("Task description/notes. Optional for add and update."),
    taskId: param.string("Task ID (uid). Required for complete, update, and delete."),
    priority: param.enum(
      "Task priority.",
      ["low", "medium", "high"] as const,
    ),
    dueDate: param.date("Due date. Optional for add and update.", { format: "date" }),
    status: param.enum(
      "Filter status for list action. Default: pending.",
      ["all", "pending", "completed"] as const,
    ),
  },

  handler: async (
    { action, title, description, taskId, priority, dueDate, status },
    { toolConfig, userId },
  ) => {
    const config = extractGoogleConfig(toolConfig);

    if (!userId) {
      return "Error: Tasks require a user context. Run this in a Discord channel or DM.";
    }

    try {
      const taskListId = await resolveUserTaskList(config, userId);

      switch (action) {
        case "list": {
          const items = await listTasks(
            config,
            taskListId,
            (status as "all" | "pending" | "completed") ?? "pending",
          );
          if (items.length === 0) {
            return { text: "No tasks found.", data: { action: "list", count: 0, tasks: [] } };
          }
          const lines = items.map((t, i) => {
            let line = `${i + 1}. [${t.completed ? "x" : " "}] ${t.title}`;
            if (t.dueDate) line += ` (due ${t.dueDate})`;
            if (t.description) line += `\n   ${t.description.slice(0, 100)}`;
            line += `\n   ID: ${t.uid}`;
            return line;
          });
          return {
            text: `Tasks (${items.length}):\n\n${lines.join("\n\n")}`,
            data: { action: "list", count: items.length, tasks: items },
          };
        }

        case "add": {
          if (!title) return "Error: title is required for add.";
          const item = await createTask(config, taskListId, {
            title: title as string,
            description: description as string | undefined,
            priority: priority as string | undefined,
            dueDate: dueDate as string | undefined,
          });
          return {
            text: `Task added: ${item.title}${item.dueDate ? ` (due ${item.dueDate})` : ""}\nID: ${item.uid}`,
            data: { action: "add", task: item },
          };
        }

        case "complete": {
          if (!taskId) return "Error: taskId is required for complete.";
          const item = await completeTask(config, taskId as string, taskListId);
          if (!item) return `Error: task "${taskId}" not found.`;
          return {
            text: `Task completed: ${item.title}`,
            data: { action: "complete", task: item },
          };
        }

        case "update": {
          if (!taskId) return "Error: taskId is required for update.";
          const item = await updateTask(config, taskId as string, {
            title: title as string | undefined,
            description: description as string | undefined,
            priority: priority as string | undefined,
            dueDate: dueDate as string | undefined,
          }, taskListId);
          if (!item) return `Error: task "${taskId}" not found.`;
          return {
            text: `Task updated: ${item.title}`,
            data: { action: "update", task: item },
          };
        }

        case "delete": {
          if (!taskId) return "Error: taskId is required for delete.";
          const deleted = await deleteTask(config, taskId as string, taskListId);
          if (!deleted) return `Error: task "${taskId}" not found.`;
          return {
            text: `Task deleted (ID: ${taskId}).`,
            data: { action: "delete", uid: taskId },
          };
        }

        default:
          return `Error: unknown action "${action}".`;
      }
    } catch (err) {
      resetGoogleToken();
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

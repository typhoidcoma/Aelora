import { defineTool, param } from "./types.js";
import { googleFetch, extractGoogleConfig, resetGoogleToken, type GoogleConfig } from "./_google-auth.js";

const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";

// ============================================================
// Types
// ============================================================

export type TodoItem = {
  uid: string;           // Google Task id
  title: string;
  description?: string;  // Google Tasks "notes"
  completed: boolean;
  priority: "low" | "medium" | "high";  // metadata only (Google Tasks has no priority field)
  dueDate?: string;      // ISO 8601 date (YYYY-MM-DD)
  updatedAt?: string;    // Google Tasks "updated" timestamp
};

export type ScoredTodoItem = TodoItem & {
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

function taskToTodoItem(task: GoogleTask): TodoItem {
  return {
    uid: task.id,
    title: task.title,
    description: task.notes,
    completed: task.status === "completed",
    priority: "medium",  // Google Tasks has no priority — overlaid from Supabase later
    dueDate: task.due ? task.due.slice(0, 10) : undefined,  // extract YYYY-MM-DD
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
// CRUD operations (exported for use by web.ts API routes)
// ============================================================

export async function listTodos(
  config: GoogleConfig,
  taskListId = "@default",
  status: "all" | "pending" | "completed" = "pending",
): Promise<TodoItem[]> {
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
    throw new Error(`Google Tasks API error (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { items?: GoogleTask[] };
  const items = (data.items ?? []).map(taskToTodoItem);

  if (status === "pending") return items.filter((t) => !t.completed);
  if (status === "completed") return items.filter((t) => t.completed);
  return items;
}

export async function getTodoByUid(
  config: GoogleConfig,
  uid: string,
  taskListId = "@default",
): Promise<TodoItem | null> {
  const res = await googleFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(uid)}`,
    config,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Google Tasks API error (${res.status})`);
  const task = (await res.json()) as GoogleTask;
  return taskToTodoItem(task);
}

export async function createTodo(
  config: GoogleConfig,
  opts: {
    title: string;
    description?: string;
    priority?: string;
    dueDate?: string;
    taskListId?: string;
  },
): Promise<TodoItem> {
  const listId = opts.taskListId ?? "@default";
  const body: Record<string, unknown> = { title: opts.title };
  if (opts.description) body.notes = opts.description;
  if (opts.dueDate) body.due = `${opts.dueDate}T00:00:00.000Z`;

  const res = await googleFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks`,
    config,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google Tasks API error (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const task = (await res.json()) as GoogleTask;
  const item = taskToTodoItem(task);
  // Preserve priority from opts in the immediate response
  if (opts.priority && ["low", "medium", "high"].includes(opts.priority)) {
    item.priority = opts.priority as "low" | "medium" | "high";
  }
  return item;
}

export async function completeTodo(
  config: GoogleConfig,
  uid: string,
  taskListId = "@default",
): Promise<TodoItem | null> {
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
  if (!res.ok) throw new Error(`Google Tasks API error (${res.status})`);
  const task = (await res.json()) as GoogleTask;
  return taskToTodoItem(task);
}

export async function updateTodoItem(
  config: GoogleConfig,
  uid: string,
  updates: {
    title?: string;
    description?: string;
    priority?: string;
    dueDate?: string;
  },
  taskListId = "@default",
): Promise<TodoItem | null> {
  const patch: Record<string, unknown> = {};
  if (updates.title) patch.title = updates.title;
  if (updates.description !== undefined) patch.notes = updates.description;
  if (updates.dueDate) patch.due = `${updates.dueDate}T00:00:00.000Z`;

  if (Object.keys(patch).length === 0) {
    // Only priority changed — priority is Supabase-only, fetch current task for response
    return getTodoByUid(config, uid, taskListId);
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
  if (!res.ok) throw new Error(`Google Tasks API error (${res.status})`);

  const task = (await res.json()) as GoogleTask;
  const item = taskToTodoItem(task);
  if (updates.priority && ["low", "medium", "high"].includes(updates.priority)) {
    item.priority = updates.priority as "low" | "medium" | "high";
  }
  return item;
}

export async function deleteTodoItem(
  config: GoogleConfig,
  uid: string,
  taskListId = "@default",
): Promise<boolean> {
  const res = await googleFetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(uid)}`,
    config,
    { method: "DELETE" },
  );
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Google Tasks API error (${res.status})`);
  return true;
}

// ============================================================
// LLM Tool definition
// ============================================================

export default defineTool({
  name: "todo",
  description:
    "Manage todos and tasks. Actions: list, add, complete, update, delete. " +
    "Uses Google Tasks as the backend. Priority is stored as metadata and does not " +
    "sync to Google Tasks (Google Tasks has no priority field).",

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  params: {
    action: param.enum(
      "Action to perform.",
      ["list", "add", "complete", "update", "delete"] as const,
      { required: true },
    ),
    title: param.string("Task title. Required for add."),
    description: param.string("Task description/notes. Optional for add and update."),
    todoId: param.string("Task ID (uid). Required for complete, update, and delete."),
    priority: param.enum(
      "Task priority (stored as metadata, not synced to Google Tasks).",
      ["low", "medium", "high"] as const,
    ),
    dueDate: param.date("Due date. Optional for add and update.", { format: "date" }),
    status: param.enum(
      "Filter status for list action. Default: pending.",
      ["all", "pending", "completed"] as const,
    ),
  },

  handler: async (
    { action, title, description, todoId, priority, dueDate, status },
    { toolConfig },
  ) => {
    const config = extractGoogleConfig(toolConfig);
    try {
      switch (action) {
        case "list": {
          const items = await listTodos(
            config,
            "@default",
            (status as "all" | "pending" | "completed") ?? "pending",
          );
          if (items.length === 0) {
            return { text: "No todos found.", data: { action: "list", count: 0, todos: [] } };
          }
          const lines = items.map((t, i) => {
            let line = `${i + 1}. [${t.completed ? "x" : " "}] ${t.title}`;
            if (t.dueDate) line += ` (due ${t.dueDate})`;
            if (t.description) line += `\n   ${t.description.slice(0, 100)}`;
            line += `\n   ID: ${t.uid}`;
            return line;
          });
          return {
            text: `Todos (${items.length}):\n\n${lines.join("\n\n")}`,
            data: { action: "list", count: items.length, todos: items },
          };
        }

        case "add": {
          if (!title) return "Error: title is required for add.";
          const item = await createTodo(config, {
            title: title as string,
            description: description as string | undefined,
            priority: priority as string | undefined,
            dueDate: dueDate as string | undefined,
          });
          return {
            text: `Todo added: ${item.title}${item.dueDate ? ` (due ${item.dueDate})` : ""}\nID: ${item.uid}`,
            data: { action: "add", todo: item },
          };
        }

        case "complete": {
          if (!todoId) return "Error: todoId is required for complete.";
          const item = await completeTodo(config, todoId as string);
          if (!item) return `Error: todo "${todoId}" not found.`;
          return {
            text: `Todo completed: ${item.title}`,
            data: { action: "complete", todo: item },
          };
        }

        case "update": {
          if (!todoId) return "Error: todoId is required for update.";
          const item = await updateTodoItem(config, todoId as string, {
            title: title as string | undefined,
            description: description as string | undefined,
            priority: priority as string | undefined,
            dueDate: dueDate as string | undefined,
          });
          if (!item) return `Error: todo "${todoId}" not found.`;
          return {
            text: `Todo updated: ${item.title}`,
            data: { action: "update", todo: item },
          };
        }

        case "delete": {
          if (!todoId) return "Error: todoId is required for delete.";
          const deleted = await deleteTodoItem(config, todoId as string);
          if (!deleted) return `Error: todo "${todoId}" not found.`;
          return {
            text: `Todo deleted (ID: ${todoId}).`,
            data: { action: "delete", uid: todoId },
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

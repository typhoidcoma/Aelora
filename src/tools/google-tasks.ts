import { defineTool, param } from "./types.js";
import { googleFetch, extractGoogleConfig, resetGoogleToken } from "./_google-auth.js";

const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";

// ── Types ────────────────────────────────────────────────────

type TaskList = {
  id: string;
  title: string;
  updated: string;
};

type Task = {
  id: string;
  title: string;
  notes?: string;
  status: "needsAction" | "completed";
  due?: string;
  completed?: string;
  parent?: string;
  position: string;
  updated: string;
};

// ── Helpers ──────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatTask(t: Task, index: number): string {
  const check = t.status === "completed" ? "[x]" : "[ ]";
  let line = `${index}. ${check} ${t.title}`;
  if (t.due) line += `\n   Due: ${formatDate(t.due)}`;
  if (t.notes) line += `\n   Notes: ${t.notes.slice(0, 150)}`;
  line += `\n   ID: ${t.id}`;
  return line;
}

// ── Tool ─────────────────────────────────────────────────────

export default defineTool({
  name: "google_tasks",
  description:
    "Manage tasks on Google Tasks. Add, list, complete, update, and delete tasks. Tasks sync with Gmail and Google Calendar.",

  params: {
    action: param.enum(
      "The action to perform.",
      ["list", "add", "complete", "update", "delete", "lists"] as const,
      { required: true },
    ),
    title: param.string("Task title. Required for add."),
    notes: param.string("Task notes/description. Optional for add and update."),
    dueDate: param.string(
      "Due date in YYYY-MM-DD format. Optional for add and update. Google Tasks only supports dates, not times.",
    ),
    taskId: param.string("Task ID. Required for complete, update, delete."),
    taskListId: param.string("Task list ID (default: '@default' which is the primary list). Use 'lists' action to see all lists."),
    showCompleted: param.boolean("Include completed tasks in list results. Default: false."),
    maxResults: param.number("Max tasks to return for list (1-100, default 20).", { minimum: 1, maximum: 100 }),
  },

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  handler: async (
    { action, title, notes, dueDate, taskId, taskListId, showCompleted, maxResults },
    { toolConfig },
  ) => {
    const config = extractGoogleConfig(toolConfig);
    const listId = taskListId || "@default";

    try {
      switch (action) {
        // ── List tasks ───────────────────────────────────────
        case "list": {
          const max = maxResults ?? 20;
          const params = new URLSearchParams({
            maxResults: String(max),
            showCompleted: String(showCompleted ?? false),
            showHidden: String(showCompleted ?? false),
          });

          const res = await googleFetch(
            `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks?${params}`,
            config,
          );
          if (!res.ok) {
            const errBody = await res.text();
            return `Error: failed to fetch tasks (${res.status}): ${errBody.slice(0, 300)}`;
          }

          const data = (await res.json()) as { items?: Task[] };
          const tasks = data.items ?? [];

          if (tasks.length === 0) {
            return "No tasks found.";
          }

          let result = `Tasks (${tasks.length}):\n`;
          for (let i = 0; i < tasks.length; i++) {
            result += `\n${formatTask(tasks[i], i + 1)}\n`;
          }

          return result;
        }

        // ── Add task ─────────────────────────────────────────
        case "add": {
          if (!title) return "Error: title is required for add.";

          const task: Record<string, unknown> = { title };
          if (notes) task.notes = notes;
          if (dueDate) task.due = `${dueDate}T00:00:00.000Z`;

          const res = await googleFetch(
            `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks`,
            config,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(task),
            },
          );

          if (!res.ok) {
            const errBody = await res.text();
            return `Error: failed to add task (${res.status}): ${errBody.slice(0, 300)}`;
          }

          const created = (await res.json()) as Task;
          let result = `Task added: ${created.title}`;
          if (created.due) result += `\nDue: ${formatDate(created.due)}`;
          if (created.notes) result += `\nNotes: ${created.notes}`;
          result += `\nID: ${created.id}`;

          return result;
        }

        // ── Complete task ────────────────────────────────────
        case "complete": {
          if (!taskId) return "Error: taskId is required for complete.";

          const res = await googleFetch(
            `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
            config,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "completed" }),
            },
          );

          if (!res.ok) {
            if (res.status === 404) return `Error: task not found (ID: ${taskId}).`;
            return `Error: failed to complete task (${res.status}).`;
          }

          const updated = (await res.json()) as Task;
          return `Task completed: ${updated.title}`;
        }

        // ── Update task ──────────────────────────────────────
        case "update": {
          if (!taskId) return "Error: taskId is required for update.";

          const patch: Record<string, unknown> = {};
          if (title) patch.title = title;
          if (notes) patch.notes = notes;
          if (dueDate) patch.due = `${dueDate}T00:00:00.000Z`;

          if (Object.keys(patch).length === 0) {
            return "Error: provide at least one field to update (title, notes, dueDate).";
          }

          const res = await googleFetch(
            `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
            config,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            },
          );

          if (!res.ok) {
            if (res.status === 404) return `Error: task not found (ID: ${taskId}).`;
            return `Error: failed to update task (${res.status}).`;
          }

          const updated = (await res.json()) as Task;
          let result = `Task updated: ${updated.title}`;
          if (updated.due) result += `\nDue: ${formatDate(updated.due)}`;
          if (updated.notes) result += `\nNotes: ${updated.notes}`;
          result += `\nID: ${updated.id}`;

          return result;
        }

        // ── Delete task ──────────────────────────────────────
        case "delete": {
          if (!taskId) return "Error: taskId is required for delete.";

          const res = await googleFetch(
            `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
            config,
            { method: "DELETE" },
          );

          if (!res.ok) {
            if (res.status === 404) return `Error: task not found (ID: ${taskId}).`;
            return `Error: failed to delete task (${res.status}).`;
          }

          return `Task deleted (ID: ${taskId}).`;
        }

        // ── List task lists ──────────────────────────────────
        case "lists": {
          const res = await googleFetch(`${TASKS_BASE}/users/@me/lists`, config);
          if (!res.ok) {
            const errBody = await res.text();
            return `Error: failed to fetch task lists (${res.status}): ${errBody.slice(0, 300)}`;
          }

          const data = (await res.json()) as { items?: TaskList[] };
          const lists = data.items ?? [];

          if (lists.length === 0) {
            return "No task lists found.";
          }

          let result = "Google Task Lists:\n";
          for (const l of lists) {
            result += `\n  ${l.title}\n`;
            result += `  ID: ${l.id}\n`;
            result += `  Updated: ${formatDate(l.updated)}\n`;
          }

          return result;
        }

        default:
          return `Error: unknown action "${action}". Use: list, add, complete, update, delete, lists.`;
      }
    } catch (err) {
      resetGoogleToken();
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Google Tasks tool error:", msg);
      return `Error: Google Tasks operation failed: ${msg}`;
    }
  },
});

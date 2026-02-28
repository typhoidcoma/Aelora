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
    "Manage tasks on Google Tasks. Add, list, complete, update, and delete tasks. Use add_many to create multiple tasks in one call. Tasks sync with Gmail and Google Calendar.",

  params: {
    action: param.enum(
      "The action to perform.",
      ["list", "add", "add_many", "complete", "update", "delete", "lists"] as const,
      { required: true },
    ),
    title: param.string("Task title. Required for add."),
    tasks: param.string(
      "JSON array of tasks for add_many. Each item: {\"title\": \"...\", \"notes?\": \"...\", \"dueDate?\": \"YYYY-MM-DD\"}. Required for add_many.",
    ),
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
    { action, title, tasks, notes, dueDate, taskId, taskListId, showCompleted, maxResults },
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
          const items = data.items ?? [];

          if (items.length === 0) {
            return { text: "No tasks found.", data: { action: "list", count: 0, tasks: [] } };
          }

          let text = `Tasks (${items.length}):\n`;
          for (let i = 0; i < items.length; i++) {
            text += `\n${formatTask(items[i], i + 1)}\n`;
          }

          return {
            text,
            data: {
              action: "list",
              count: items.length,
              taskListId: listId,
              tasks: items.map(t => ({
                id: t.id,
                title: t.title,
                notes: t.notes ?? null,
                status: t.status,
                due: t.due ?? null,
                completed: t.completed ?? null,
                updated: t.updated,
              })),
            },
          };
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
          let text = `Task added: ${created.title}`;
          if (created.due) text += `\nDue: ${formatDate(created.due)}`;
          if (created.notes) text += `\nNotes: ${created.notes}`;
          text += `\nID: ${created.id}`;

          return {
            text,
            data: {
              action: "add",
              task: { id: created.id, title: created.title, notes: created.notes ?? null, status: created.status, due: created.due ?? null },
            },
          };
        }

        // ── Add many tasks ─────────────────────────────────
        case "add_many": {
          if (!tasks) return "Error: tasks JSON array is required for add_many.";

          let parsedItems: { title: string; notes?: string; dueDate?: string }[];
          try {
            parsedItems = JSON.parse(tasks);
          } catch {
            return "Error: tasks must be a valid JSON array.";
          }

          if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
            return "Error: tasks must be a non-empty array.";
          }

          const lines: string[] = [];
          const createdTasks: { id: string; title: string; notes: string | null; status: string; due: string | null }[] = [];
          let added = 0;

          for (const item of parsedItems) {
            if (!item.title) {
              lines.push(`Skipped: missing title`);
              continue;
            }

            const task: Record<string, unknown> = { title: item.title };
            if (item.notes) task.notes = item.notes;
            if (item.dueDate) task.due = `${item.dueDate}T00:00:00.000Z`;

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
              lines.push(`Failed: ${item.title} (${res.status})`);
            } else {
              const created = (await res.json()) as Task;
              let line = `Added: ${created.title}`;
              if (created.due) line += ` (due ${formatDate(created.due)})`;
              lines.push(line);
              createdTasks.push({ id: created.id, title: created.title, notes: created.notes ?? null, status: created.status, due: created.due ?? null });
              added++;
            }
          }

          return {
            text: `Added ${added}/${parsedItems.length} tasks:\n${lines.join("\n")}`,
            data: { action: "add_many", added, total: parsedItems.length, tasks: createdTasks },
          };
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
          return {
            text: `Task completed: ${updated.title}`,
            data: { action: "complete", task: { id: updated.id, title: updated.title, status: updated.status } },
          };
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
          let text = `Task updated: ${updated.title}`;
          if (updated.due) text += `\nDue: ${formatDate(updated.due)}`;
          if (updated.notes) text += `\nNotes: ${updated.notes}`;
          text += `\nID: ${updated.id}`;

          return {
            text,
            data: {
              action: "update",
              task: { id: updated.id, title: updated.title, notes: updated.notes ?? null, status: updated.status, due: updated.due ?? null },
            },
          };
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

          return {
            text: `Task deleted (ID: ${taskId}).`,
            data: { action: "delete", taskId },
          };
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
            return { text: "No task lists found.", data: { action: "lists", count: 0, lists: [] } };
          }

          let text = "Google Task Lists:\n";
          for (const l of lists) {
            text += `\n  ${l.title}\n`;
            text += `  ID: ${l.id}\n`;
            text += `  Updated: ${formatDate(l.updated)}\n`;
          }

          return {
            text,
            data: {
              action: "lists",
              count: lists.length,
              lists: lists.map(l => ({ id: l.id, title: l.title, updated: l.updated })),
            },
          };
        }

        default:
          return `Error: unknown action "${action}". Use: list, add, add_many, complete, update, delete, lists.`;
      }
    } catch (err) {
      resetGoogleToken();
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Google Tasks tool error:", msg);
      return `Error: Google Tasks operation failed: ${msg}`;
    }
  },
});

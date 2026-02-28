import { randomUUID } from "node:crypto";
import { defineTool, param } from "./types.js";
import {
  getClient,
  toICSDateTime,
  icsDateToISO,
  getICSProp,
  getICSDateValue,
  type DAVClientInstance,
} from "./calendar.js";

// ============================================================
// Types
// ============================================================

export type TodoItem = {
  uid: string;
  title: string;
  description?: string;
  completed: boolean;
  priority: "low" | "medium" | "high";
  dueDate?: string;
  url: string;
  etag: string;
  createdAt?: string;
  updatedAt?: string;
};

// ============================================================
// RFC 5545 priority mapping
// ============================================================

const PRIORITY_TO_ICS: Record<string, number> = { high: 1, medium: 5, low: 9 };
const PRIORITY_FROM_ICS: Record<number, "high" | "medium" | "low"> = {
  1: "high", 2: "high", 3: "high", 4: "high",
  5: "medium",
  6: "low", 7: "low", 8: "low", 9: "low",
};

function icsPriority(n: string): "low" | "medium" | "high" {
  const num = parseInt(n, 10);
  if (isNaN(num) || num === 0) return "medium";
  return PRIORITY_FROM_ICS[num] ?? "medium";
}

// ============================================================
// VTODO ICS helpers
// ============================================================

function buildVTODO(opts: {
  uid: string;
  summary: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  dueDate?: string;
  status?: "NEEDS-ACTION" | "COMPLETED";
  completedDate?: string;
}): string {
  const now = toICSDateTime(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Aelora//Calendar//EN",
    "BEGIN:VTODO",
    `UID:${opts.uid}`,
    `DTSTAMP:${now}`,
    `CREATED:${now}`,
    `LAST-MODIFIED:${now}`,
    `SUMMARY:${opts.summary}`,
    `STATUS:${opts.status ?? "NEEDS-ACTION"}`,
    `PRIORITY:${PRIORITY_TO_ICS[opts.priority ?? "medium"]}`,
  ];

  if (opts.description) lines.push(`DESCRIPTION:${opts.description}`);
  if (opts.dueDate) lines.push(`DUE:${toICSDateTime(opts.dueDate)}`);
  if (opts.status === "COMPLETED" && opts.completedDate) {
    lines.push(`COMPLETED:${toICSDateTime(opts.completedDate)}`);
  }

  lines.push("END:VTODO", "END:VCALENDAR");
  return lines.join("\r\n");
}

function parseVTODO(ics: string, url: string, etag: string): TodoItem {
  const status = getICSProp(ics, "STATUS") || "NEEDS-ACTION";
  const priorityStr = getICSProp(ics, "PRIORITY") || "0";
  const dueRaw = getICSDateValue(ics, "DUE");
  const createdRaw = getICSDateValue(ics, "CREATED");
  const modifiedRaw = getICSDateValue(ics, "LAST-MODIFIED");

  return {
    uid: getICSProp(ics, "UID") || "",
    title: getICSProp(ics, "SUMMARY") || "(No title)",
    description: getICSProp(ics, "DESCRIPTION") || undefined,
    completed: status === "COMPLETED",
    priority: icsPriority(priorityStr),
    dueDate: dueRaw ? icsDateToISO(dueRaw) : undefined,
    url,
    etag: etag || "",
    createdAt: createdRaw ? icsDateToISO(createdRaw) : undefined,
    updatedAt: modifiedRaw ? icsDateToISO(modifiedRaw) : undefined,
  };
}

// ============================================================
// VTODO filter for tsdav
// ============================================================

const VTODO_FILTER = [
  {
    "comp-filter": {
      _attributes: { name: "VCALENDAR" },
      "comp-filter": { _attributes: { name: "VTODO" } },
    },
  },
];

// ============================================================
// Data helpers (exported for REST API)
// ============================================================

async function resolveCalendar(client: DAVClientInstance, calendarName?: string) {
  const calendars = await client.fetchCalendars();
  if (calendars.length === 0) return null;
  return (calendarName ? calendars.find((c) => c.displayName === calendarName) : null) ?? calendars[0];
}

export async function listTodos(
  client: DAVClientInstance,
  calendarName?: string,
  status?: "all" | "pending" | "completed",
): Promise<TodoItem[]> {
  const calendar = await resolveCalendar(client, calendarName);
  if (!calendar) return [];

  const objects = await client.fetchCalendarObjects({
    calendar,
    filters: VTODO_FILTER,
  });

  if (!objects || objects.length === 0) return [];

  let items = objects
    .filter((o) => o.data && String(o.data).includes("VTODO"))
    .map((o) => parseVTODO(o.data as string, o.url, o.etag ?? ""));

  if (status === "pending") items = items.filter((t) => !t.completed);
  else if (status === "completed") items = items.filter((t) => t.completed);

  return items;
}

export async function getTodoByUid(
  client: DAVClientInstance,
  calendarName: string | undefined,
  uid: string,
): Promise<TodoItem | null> {
  const todos = await listTodos(client, calendarName, "all");
  return todos.find((t) => t.uid === uid) ?? null;
}

export async function createTodo(
  client: DAVClientInstance,
  calendarName: string | undefined,
  opts: { title: string; description?: string; priority?: "low" | "medium" | "high"; dueDate?: string },
): Promise<TodoItem> {
  const calendar = await resolveCalendar(client, calendarName);
  if (!calendar) throw new Error("No calendars found on CalDAV server");

  const uid = `${randomUUID()}@aelora`;
  const filename = `${uid}.ics`;

  const ics = buildVTODO({
    uid,
    summary: opts.title,
    description: opts.description,
    priority: opts.priority,
    dueDate: opts.dueDate,
  });

  const res = await client.createCalendarObject({
    calendar,
    iCalString: ics,
    filename,
  });

  if (!res.ok) {
    throw new Error(`CalDAV create failed: ${res.status} ${res.statusText}`);
  }

  const todoUrl = new URL(filename, calendar.url).toString();
  const etag = res.headers.get("etag") ?? "";

  return {
    uid,
    title: opts.title,
    description: opts.description,
    completed: false,
    priority: opts.priority ?? "medium",
    dueDate: opts.dueDate,
    url: todoUrl,
    etag,
  };
}

export async function completeTodo(
  client: DAVClientInstance,
  calendarName: string | undefined,
  uid: string,
): Promise<TodoItem | null> {
  const todo = await getTodoByUid(client, calendarName, uid);
  if (!todo) return null;

  const objects = await client.fetchCalendarObjects({
    calendar: { url: todo.url.replace(/[^/]+\.ics$/, "") } as any,
    objectUrls: [todo.url],
  });
  if (!objects || objects.length === 0) return null;

  let ics = objects[0].data as string;
  const currentEtag = objects[0].etag ?? todo.etag;

  const now = toICSDateTime(new Date().toISOString());
  if (/^STATUS:/mi.test(ics)) {
    ics = ics.replace(/^STATUS:.*$/mi, "STATUS:COMPLETED");
  } else {
    ics = ics.replace(/^END:VTODO/mi, "STATUS:COMPLETED\r\nEND:VTODO");
  }

  if (/^COMPLETED:/mi.test(ics)) {
    ics = ics.replace(/^COMPLETED:.*$/mi, `COMPLETED:${now}`);
  } else {
    ics = ics.replace(/^END:VTODO/mi, `COMPLETED:${now}\r\nEND:VTODO`);
  }

  ics = ics.replace(/^LAST-MODIFIED:.*$/mi, `LAST-MODIFIED:${now}`);

  const res = await client.updateCalendarObject({
    calendarObject: { url: todo.url, data: ics, etag: currentEtag },
  });

  if (!res.ok) {
    throw new Error(`CalDAV update failed: ${res.status} ${res.statusText}`);
  }

  return parseVTODO(ics, todo.url, res.headers.get("etag") ?? currentEtag);
}

export async function updateTodoItem(
  client: DAVClientInstance,
  calendarName: string | undefined,
  uid: string,
  updates: { title?: string; description?: string; priority?: "low" | "medium" | "high"; dueDate?: string },
): Promise<TodoItem | null> {
  const todo = await getTodoByUid(client, calendarName, uid);
  if (!todo) return null;

  const objects = await client.fetchCalendarObjects({
    calendar: { url: todo.url.replace(/[^/]+\.ics$/, "") } as any,
    objectUrls: [todo.url],
  });
  if (!objects || objects.length === 0) return null;

  let ics = objects[0].data as string;
  const currentEtag = objects[0].etag ?? todo.etag;
  const now = toICSDateTime(new Date().toISOString());

  if (updates.title) {
    ics = ics.replace(/^SUMMARY:.*$/mi, `SUMMARY:${updates.title}`);
  }

  if (updates.description !== undefined) {
    if (/^DESCRIPTION:/mi.test(ics)) {
      ics = ics.replace(/^DESCRIPTION:.*$/mi, `DESCRIPTION:${updates.description}`);
    } else {
      ics = ics.replace(/^END:VTODO/mi, `DESCRIPTION:${updates.description}\r\nEND:VTODO`);
    }
  }

  if (updates.priority) {
    const pVal = PRIORITY_TO_ICS[updates.priority];
    if (/^PRIORITY:/mi.test(ics)) {
      ics = ics.replace(/^PRIORITY:.*$/mi, `PRIORITY:${pVal}`);
    } else {
      ics = ics.replace(/^END:VTODO/mi, `PRIORITY:${pVal}\r\nEND:VTODO`);
    }
  }

  if (updates.dueDate !== undefined) {
    const dueVal = updates.dueDate ? toICSDateTime(updates.dueDate) : "";
    if (/^DUE:/mi.test(ics)) {
      if (dueVal) {
        ics = ics.replace(/^DUE:.*$/mi, `DUE:${dueVal}`);
      } else {
        ics = ics.replace(/^DUE:.*\r?\n?/mi, "");
      }
    } else if (dueVal) {
      ics = ics.replace(/^END:VTODO/mi, `DUE:${dueVal}\r\nEND:VTODO`);
    }
  }

  ics = ics.replace(/^LAST-MODIFIED:.*$/mi, `LAST-MODIFIED:${now}`);

  const res = await client.updateCalendarObject({
    calendarObject: { url: todo.url, data: ics, etag: currentEtag },
  });

  if (!res.ok) {
    throw new Error(`CalDAV update failed: ${res.status} ${res.statusText}`);
  }

  return parseVTODO(ics, todo.url, res.headers.get("etag") ?? currentEtag);
}

export async function deleteTodoItem(
  client: DAVClientInstance,
  calendarName: string | undefined,
  uid: string,
): Promise<boolean> {
  const todo = await getTodoByUid(client, calendarName, uid);
  if (!todo) return false;

  const res = await client.deleteCalendarObject({
    calendarObject: { url: todo.url, etag: todo.etag },
  });

  return res.ok || res.status === 204;
}

// ============================================================
// Formatters
// ============================================================

function formatTodo(item: TodoItem): string {
  const check = item.completed ? "[x]" : "[ ]";
  const priority = item.priority !== "medium" ? ` (${item.priority})` : "";
  const due = item.dueDate ? ` — due ${item.dueDate}` : "";
  const desc = item.description ? `\n  ${item.description}` : "";
  return `${check} **${item.title}**${priority}${due} \`${item.uid}\`${desc}`;
}

// ============================================================
// Tool definition
// ============================================================

export default defineTool({
  name: "todo",
  description:
    "Manage to-do items via CalDAV (VTODO). Add, list, complete, update, or delete tasks. " +
    "Tasks are stored on the CalDAV server and sync with any CalDAV client.",

  config: [
    "caldav.serverUrl",
    "caldav.username",
    "caldav.password",
    "caldav.authMethod",
  ],

  params: {
    action: param.enum(
      "The action to perform.",
      ["add", "list", "complete", "update", "delete"] as const,
      { required: true },
    ),
    title: param.string("Todo title. Required for add.", { maxLength: 200 }),
    description: param.string("Todo description. Optional for add/update."),
    todoId: param.string("Todo UID (from list results). Required for complete, update, delete."),
    priority: param.enum("Priority level. Default: medium.", ["low", "medium", "high"] as const),
    dueDate: param.date("Due date in the user's local timezone (e.g. '2025-03-15' or '2025-03-15T14:00:00'). Do NOT append Z or UTC offset. Optional for add/update."),
    status: param.enum("Filter for list.", ["all", "pending", "completed"] as const),
  },

  handler: async ({ action, title, description, todoId, priority, dueDate, status }, { toolConfig }) => {
    const { serverUrl, username, password, authMethod } = toolConfig as {
      serverUrl: string;
      username: string;
      password: string;
      authMethod: string;
    };
    const calendarName = (toolConfig as Record<string, unknown>).calendarName as string | undefined;

    let client: DAVClientInstance;
    try {
      client = await getClient({ serverUrl, username, password, authMethod: authMethod || "Basic" });
    } catch (err) {
      return `Error: failed to connect to CalDAV server: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      switch (action) {
        case "add": {
          if (!title) return "Error: title is required for add.";
          const item = await createTodo(client, calendarName, { title, description, priority, dueDate });
          return { text: "Added todo: " + formatTodo(item), data: { action: "add", todo: item } };
        }

        case "list": {
          const items = await listTodos(client, calendarName, status ?? "all");
          if (items.length === 0) return { text: "No todos found.", data: { action: "list", count: 0, todos: [] } };

          const pending = items.filter((t) => !t.completed);
          const done = items.filter((t) => t.completed);
          const lines: string[] = [];

          if (pending.length > 0) {
            lines.push(`**Pending** (${pending.length}):`);
            for (const t of pending) lines.push(formatTodo(t));
          }
          if (done.length > 0) {
            if (lines.length > 0) lines.push("");
            lines.push(`**Completed** (${done.length}):`);
            for (const t of done) lines.push(formatTodo(t));
          }

          return { text: lines.join("\n"), data: { action: "list", count: items.length, pending: pending.length, completed: done.length, todos: items } };
        }

        case "complete": {
          if (!todoId) return "Error: todoId is required for complete.";
          const item = await completeTodo(client, calendarName, todoId);
          if (!item) return `Error: no todo found with UID "${todoId}".`;
          return { text: "Completed: " + formatTodo(item), data: { action: "complete", todo: item } };
        }

        case "update": {
          if (!todoId) return "Error: todoId is required for update.";
          const updates: { title?: string; description?: string; priority?: "low" | "medium" | "high"; dueDate?: string } = {};
          if (title) updates.title = title;
          if (description) updates.description = description;
          if (priority) updates.priority = priority;
          if (dueDate) updates.dueDate = dueDate;

          if (Object.keys(updates).length === 0) {
            return "Error: provide at least one field to update (title, description, priority, or dueDate).";
          }

          const item = await updateTodoItem(client, calendarName, todoId, updates);
          if (!item) return `Error: no todo found with UID "${todoId}".`;
          return { text: "Updated: " + formatTodo(item), data: { action: "update", todo: item } };
        }

        case "delete": {
          if (!todoId) return "Error: todoId is required for delete.";
          const deleted = await deleteTodoItem(client, calendarName, todoId);
          if (!deleted) return `Error: no todo found with UID "${todoId}".`;
          return { text: `Deleted todo "${todoId}".`, data: { action: "delete", todoId } };
        }

        default:
          return `Error: unknown action "${action}". Use add, list, complete, update, or delete.`;
      }
    } catch (err) {
      return `Error: todo operation failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

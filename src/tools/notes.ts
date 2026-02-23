import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool, param } from "./types.js";

const DATA_DIR = "data";
const NOTES_FILE = join(DATA_DIR, "notes.json");

export type Note = {
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type NoteStore = Record<string, Record<string, Note>>;

export function loadNotes(): NoteStore {
  try {
    if (existsSync(NOTES_FILE)) {
      return JSON.parse(readFileSync(NOTES_FILE, "utf-8"));
    }
  } catch {
    console.warn("Notes: failed to read notes file, starting fresh");
  }
  return {};
}

function saveNotes(store: NoteStore): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(NOTES_FILE, JSON.stringify(store, null, 2), "utf-8");
}

function resolveScope(scope: string | undefined, channelId: string | null): string {
  if (scope === "global") return "global";
  if (channelId) return `channel:${channelId}`;
  return "global";
}

// --- Exported data helpers (used by REST API) ---

export function listAllNotes(): NoteStore {
  return loadNotes();
}

export function listNotesByScope(scope: string): Record<string, Note> {
  return loadNotes()[scope] ?? {};
}

export function getNote(scope: string, title: string): Note | undefined {
  return loadNotes()[scope]?.[title];
}

export function upsertNote(scope: string, title: string, content: string): Note {
  const store = loadNotes();
  if (!store[scope]) store[scope] = {};
  const now = new Date().toISOString();
  const existing = store[scope][title];
  const note: Note = {
    content,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store[scope][title] = note;
  saveNotes(store);
  return note;
}

export function deleteNote(scope: string, title: string): boolean {
  const store = loadNotes();
  if (!store[scope]?.[title]) return false;
  delete store[scope][title];
  if (Object.keys(store[scope]).length === 0) delete store[scope];
  saveNotes(store);
  return true;
}

// --- Tool definition ---

export default defineTool({
  name: "notes",
  description:
    "Save, retrieve, list, or delete notes. Notes persist across restarts. " +
    "Use scope 'channel' for channel-specific notes or 'global' for shared notes.",

  params: {
    action: param.enum("The action to perform.", ["save", "get", "list", "delete"] as const, {
      required: true,
    }),
    title: param.string("The note title. Required for save, get, and delete.", {
      maxLength: 200,
    }),
    content: param.string("The note content. Required for save."),
    scope: param.enum(
      "Note scope: 'channel' (default) for this channel, or 'global' for all channels.",
      ["channel", "global"] as const,
    ),
  },

  handler: async ({ action, title, content, scope }, { channelId }) => {
    const bucket = resolveScope(scope, channelId);

    switch (action) {
      case "save": {
        if (!title) return "Error: title is required for save.";
        if (!content) return "Error: content is required for save.";
        upsertNote(bucket, title, content);
        return `Saved note "${title}" (${bucket === "global" ? "global" : "this channel"}).`;
      }

      case "get": {
        if (!title) return "Error: title is required for get.";
        const note = getNote(bucket, title);
        if (!note) return `No note found with title "${title}" in ${bucket === "global" ? "global" : "this channel"}.`;
        return `**${title}**\n${note.content}\n\n_Saved: ${note.createdAt}${note.updatedAt !== note.createdAt ? ` | Updated: ${note.updatedAt}` : ""}_`;
      }

      case "list": {
        const store = loadNotes();
        const lines: string[] = [];

        const channelNotes = store[bucket] ? Object.keys(store[bucket]) : [];
        if (bucket !== "global" && channelNotes.length > 0) {
          lines.push(`**Channel notes** (${channelNotes.length}):`);
          for (const t of channelNotes) lines.push(`- ${t}`);
        }

        const globalNotes = store["global"] ? Object.keys(store["global"]) : [];
        if (globalNotes.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(`**Global notes** (${globalNotes.length}):`);
          for (const t of globalNotes) lines.push(`- ${t}`);
        }

        if (lines.length === 0) return "No notes saved yet.";
        return lines.join("\n");
      }

      case "delete": {
        if (!title) return "Error: title is required for delete.";
        const deleted = deleteNote(bucket, title);
        if (!deleted) return `No note found with title "${title}" in ${bucket === "global" ? "global" : "this channel"}.`;
        return `Deleted note "${title}".`;
      }

      default:
        return `Unknown action "${action}". Use save, get, list, or delete.`;
    }
  },
});

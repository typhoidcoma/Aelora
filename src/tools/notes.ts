import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool, param } from "./types.js";

const DATA_DIR = "data";
const NOTES_FILE = join(DATA_DIR, "notes.json");

type Note = {
  content: string;
  createdAt: string;
  updatedAt: string;
};

type NoteStore = Record<string, Record<string, Note>>;

function load(): NoteStore {
  try {
    if (existsSync(NOTES_FILE)) {
      return JSON.parse(readFileSync(NOTES_FILE, "utf-8"));
    }
  } catch {
    console.warn("Notes: failed to read notes file, starting fresh");
  }
  return {};
}

function save(store: NoteStore): void {
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
    const store = load();
    const bucket = resolveScope(scope, channelId);

    switch (action) {
      case "save": {
        if (!title) return "Error: title is required for save.";
        if (!content) return "Error: content is required for save.";

        if (!store[bucket]) store[bucket] = {};
        const now = new Date().toISOString();
        const existing = store[bucket][title];

        store[bucket][title] = {
          content,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        save(store);
        return `Saved note "${title}" (${bucket === "global" ? "global" : "this channel"}).`;
      }

      case "get": {
        if (!title) return "Error: title is required for get.";

        const note = store[bucket]?.[title];
        if (!note) return `No note found with title "${title}" in ${bucket === "global" ? "global" : "this channel"}.`;

        return `**${title}**\n${note.content}\n\n_Saved: ${note.createdAt}${note.updatedAt !== note.createdAt ? ` | Updated: ${note.updatedAt}` : ""}_`;
      }

      case "list": {
        const lines: string[] = [];

        // Channel-specific notes
        const channelNotes = store[bucket] ? Object.keys(store[bucket]) : [];
        if (bucket !== "global" && channelNotes.length > 0) {
          lines.push(`**Channel notes** (${channelNotes.length}):`);
          for (const t of channelNotes) lines.push(`- ${t}`);
        }

        // Global notes (always shown when listing from a channel)
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

        if (!store[bucket]?.[title]) {
          return `No note found with title "${title}" in ${bucket === "global" ? "global" : "this channel"}.`;
        }

        delete store[bucket][title];
        if (Object.keys(store[bucket]).length === 0) delete store[bucket];
        save(store);
        return `Deleted note "${title}".`;
      }

      default:
        return `Unknown action "${action}". Use save, get, list, or delete.`;
    }
  },
});

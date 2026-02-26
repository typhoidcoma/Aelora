import { defineTool, param } from "./types.js";
import { googleFetch, extractGoogleConfig, resetGoogleToken } from "./_google-auth.js";

const DOCS_BASE = "https://docs.googleapis.com/v1/documents";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3/files";

// ── Helpers ──────────────────────────────────────────────────

/** Extract plain text from a Google Docs document body. */
function extractDocText(body: DocsBody): string {
  const lines: string[] = [];

  for (const element of body.content ?? []) {
    if (element.paragraph) {
      let line = "";
      for (const el of element.paragraph.elements ?? []) {
        if (el.textRun?.content) {
          line += el.textRun.content;
        }
      }
      lines.push(line);
    }
  }

  return lines.join("").trim();
}

type DocsBody = {
  content?: {
    paragraph?: {
      elements?: {
        textRun?: { content: string };
      }[];
    };
  }[];
};

type DocsDocument = {
  documentId: string;
  title: string;
  body: DocsBody;
  revisionId?: string;
};

// ── Tool ─────────────────────────────────────────────────────

export default defineTool({
  name: "google_docs",
  description:
    "Work with Google Docs. Search for documents, read their content, create new docs, and edit existing ones.",

  params: {
    action: param.enum(
      "The action to perform.",
      ["search", "read", "create", "edit"] as const,
      { required: true },
    ),
    query: param.string("Search query to find docs by name. Required for search."),
    documentId: param.string("Google Doc ID. Required for read and edit."),
    title: param.string("Document title. Required for create."),
    text: param.string("Text content to insert or append. Required for edit."),
    insertAt: param.enum("Where to insert text (default: end).", ["end", "beginning"] as const),
    maxResults: param.number("Max docs for search (1-20, default 5).", { minimum: 1, maximum: 20 }),
  },

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  handler: async ({ action, query, documentId, title, text, insertAt, maxResults }, { toolConfig }) => {
    const config = extractGoogleConfig(toolConfig);

    try {
      switch (action) {
        // ── Search ────────────────────────────────────────────
        case "search": {
          if (!query) return "Error: query is required for search.";
          const max = maxResults ?? 5;

          // Use Google Drive API to search for Google Docs
          const driveQuery = `mimeType='application/vnd.google-apps.document' and name contains '${query.replace(/'/g, "\\'")}'`;
          const params = new URLSearchParams({
            q: driveQuery,
            pageSize: String(max),
            fields: "files(id,name,modifiedTime,webViewLink,owners)",
            orderBy: "modifiedTime desc",
          });

          const res = await googleFetch(`${DRIVE_BASE}?${params}`, config);
          if (!res.ok) return `Error: search failed (${res.status}).`;

          const data = (await res.json()) as {
            files: {
              id: string;
              name: string;
              modifiedTime: string;
              webViewLink: string;
              owners?: { displayName: string }[];
            }[];
          };

          if (!data.files?.length) {
            return `No Google Docs found matching: "${query}"`;
          }

          let result = `Found ${data.files.length} doc(s) matching "${query}":\n`;
          for (let i = 0; i < data.files.length; i++) {
            const f = data.files[i];
            const modified = new Date(f.modifiedTime).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            });
            const owner = f.owners?.[0]?.displayName ?? "";
            result += `\n${i + 1}. ${f.name}\n`;
            result += `   Modified: ${modified}${owner ? ` by ${owner}` : ""}\n`;
            result += `   ID: ${f.id}\n`;
            result += `   Link: ${f.webViewLink}\n`;
          }

          return result;
        }

        // ── Read ─────────────────────────────────────────────
        case "read": {
          if (!documentId) return "Error: documentId is required for read.";

          const res = await googleFetch(`${DOCS_BASE}/${encodeURIComponent(documentId)}`, config);
          if (!res.ok) {
            if (res.status === 404) return `Error: document not found (ID: ${documentId}).`;
            return `Error: failed to read document (${res.status}).`;
          }

          const doc = (await res.json()) as DocsDocument;
          const content = extractDocText(doc.body);

          let result = `Document: ${doc.title}\n`;
          result += `ID: ${doc.documentId}\n`;
          result += `\n--- Content ---\n`;

          if (!content) {
            result += "(empty document)";
          } else if (content.length > 25000) {
            result += content.slice(0, 25000);
            result += `\n\n(content truncated — ${content.length} characters total)`;
          } else {
            result += content;
          }

          return result;
        }

        // ── Create ───────────────────────────────────────────
        case "create": {
          if (!title) return "Error: title is required for create.";

          const res = await googleFetch(DOCS_BASE, config, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
          });

          if (!res.ok) {
            const err = await res.text();
            return `Error: failed to create document (${res.status}): ${err.slice(0, 200)}`;
          }

          const doc = (await res.json()) as DocsDocument;

          // If initial text was provided, write it to the doc
          if (text) {
            const updateRes = await googleFetch(
              `${DOCS_BASE}/${doc.documentId}:batchUpdate`,
              config,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  requests: [
                    {
                      insertText: {
                        location: { index: 1 },
                        text,
                      },
                    },
                  ],
                }),
              },
            );

            if (!updateRes.ok) {
              return `Document created but failed to add initial content.\nTitle: ${doc.title}\nID: ${doc.documentId}\nLink: https://docs.google.com/document/d/${doc.documentId}/edit`;
            }
          }

          let result = `Document created: ${doc.title}\n`;
          result += `ID: ${doc.documentId}\n`;
          result += `Link: https://docs.google.com/document/d/${doc.documentId}/edit`;
          if (text) result += `\nInitial content written (${text.length} chars).`;

          return result;
        }

        // ── Edit ─────────────────────────────────────────────
        case "edit": {
          if (!documentId) return "Error: documentId is required for edit.";
          if (!text) return "Error: text is required for edit.";

          const position = insertAt ?? "end";
          let index = 1; // default: beginning

          if (position === "end") {
            // Fetch the doc to get its current length
            const docRes = await googleFetch(`${DOCS_BASE}/${encodeURIComponent(documentId)}`, config);
            if (!docRes.ok) {
              if (docRes.status === 404) return `Error: document not found (ID: ${documentId}).`;
              return `Error: failed to fetch document for editing (${docRes.status}).`;
            }

            const doc = (await docRes.json()) as DocsDocument;
            // The document body ends with a newline character at body.content[-1]
            // We insert at endIndex - 1 of the last structural element
            const lastElement = doc.body.content?.[doc.body.content.length - 1] as
              | { endIndex?: number }
              | undefined;
            if (lastElement?.endIndex) {
              index = lastElement.endIndex - 1;
            }
          }

          const res = await googleFetch(
            `${DOCS_BASE}/${encodeURIComponent(documentId)}:batchUpdate`,
            config,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                requests: [
                  {
                    insertText: {
                      location: { index },
                      text,
                    },
                  },
                ],
              }),
            },
          );

          if (!res.ok) {
            const err = await res.text();
            return `Error: failed to edit document (${res.status}): ${err.slice(0, 200)}`;
          }

          return `Text inserted at ${position} of document (${text.length} chars).\nDocument ID: ${documentId}\nLink: https://docs.google.com/document/d/${documentId}/edit`;
        }

        default:
          return `Error: unknown action "${action}". Use: search, read, create, edit.`;
      }
    } catch (err) {
      resetGoogleToken();
      return `Error: Google Docs operation failed: ${String(err)}`;
    }
  },
});

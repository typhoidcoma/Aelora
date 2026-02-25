import { defineTool, param } from "./types.js";
import { googleFetch, extractGoogleConfig, resetGoogleToken } from "./_google-auth.js";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// ── Helpers ──────────────────────────────────────────────────

/** Base64url-encode a string (for RFC 2822 messages). */
function base64url(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode a base64url-encoded string. */
function decodeBase64url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf-8");
}

/** Build an RFC 2822 message string. */
function buildRawMessage(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
  threadSubject?: string;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${opts.to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  lines.push(`Subject: ${opts.threadSubject ?? opts.subject}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push(""); // blank line separates headers from body
  lines.push(opts.body);
  return lines.join("\r\n");
}

/** Extract plain text from a Gmail message payload. */
function extractBody(payload: GmailPayload): string {
  // Simple single-part message
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64url(payload.body.data);
  }

  // Multipart — look for text/plain first, then text/html
  if (payload.parts) {
    // Check direct parts
    const plainPart = payload.parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
    if (plainPart) return decodeBase64url(plainPart.body!.data!);

    // Check nested parts (e.g. multipart/alternative inside multipart/mixed)
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = part.parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
        if (nested) return decodeBase64url(nested.body!.data!);
      }
    }

    // Fallback to html
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html" && p.body?.data);
    if (htmlPart) {
      const html = decodeBase64url(htmlPart.body!.data!);
      // Strip tags for a rough plain-text fallback
      return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    }
  }

  return "(no readable body)";
}

/** Get a header value from a Gmail message. */
function getHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Format a date string to something readable. */
function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

// ── Types ────────────────────────────────────────────────────

type GmailPayload = {
  mimeType: string;
  headers: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
};

type GmailMessage = {
  id: string;
  threadId: string;
  snippet: string;
  payload: GmailPayload;
  labelIds?: string[];
};

// ── Tool ─────────────────────────────────────────────────────

export default defineTool({
  name: "gmail",
  description:
    "Interact with the user's Gmail account. Search, read, send, reply to, and forward emails. Manage labels and create drafts.",

  params: {
    action: param.enum(
      "The action to perform.",
      ["search", "read", "send", "reply", "forward", "labels", "modify", "draft"] as const,
      { required: true },
    ),
    query: param.string("Gmail search query (e.g. 'from:boss is:unread', 'subject:invoice newer_than:7d'). Required for search."),
    messageId: param.string("Email message ID. Required for read, reply, forward."),
    to: param.string("Recipient email address. Required for send, forward, draft."),
    cc: param.string("CC recipients (comma-separated). Optional for send, reply, draft."),
    subject: param.string("Email subject line. Required for send, draft."),
    body: param.string("Email body text. Required for send, reply, forward, draft."),
    maxResults: param.number("Max emails for search (1-20, default 5).", { minimum: 1, maximum: 20 }),
    addLabels: param.string("Comma-separated label IDs to add (for modify). e.g. 'STARRED,IMPORTANT' or 'TRASH'."),
    removeLabels: param.string("Comma-separated label IDs to remove (for modify). e.g. 'INBOX' to archive, 'UNREAD' to mark read."),
  },

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  handler: async ({ action, query, messageId, to, cc, subject, body, maxResults, addLabels, removeLabels }, { toolConfig }) => {
    const config = extractGoogleConfig(toolConfig);

    try {
      switch (action) {
        // ── Search ────────────────────────────────────────────
        case "search": {
          if (!query) return "Error: query is required for search.";
          const max = maxResults ?? 5;

          const searchRes = await googleFetch(
            `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
            config,
          );
          if (!searchRes.ok) {
            const errBody = await searchRes.text();
            return `Error: Gmail search failed (${searchRes.status}): ${errBody.slice(0, 300)}`;
          }

          const searchData = (await searchRes.json()) as {
            messages?: { id: string }[];
            resultSizeEstimate: number;
          };

          if (!searchData.messages?.length) {
            return `No emails found matching: "${query}"`;
          }

          // Fetch metadata for each message
          const emails = await Promise.all(
            searchData.messages.map(async (msg) => {
              const res = await googleFetch(
                `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
                config,
              );
              const data = (await res.json()) as {
                id: string;
                snippet: string;
                payload: { headers: { name: string; value: string }[] };
              };
              const h = data.payload.headers;
              return {
                id: data.id,
                subject: getHeader(h, "Subject") || "(no subject)",
                from: getHeader(h, "From"),
                date: getHeader(h, "Date"),
                snippet: data.snippet,
              };
            }),
          );

          const total = searchData.resultSizeEstimate;
          let result = `Found ${emails.length} email(s) matching "${query}"${total > emails.length ? ` (${total} total)` : ""}:\n`;

          for (let i = 0; i < emails.length; i++) {
            const e = emails[i];
            result += `\n${i + 1}. ${e.subject}\n`;
            result += `   From: ${e.from} — ${formatDate(e.date)}\n`;
            result += `   Preview: ${e.snippet}\n`;
            result += `   ID: ${e.id}\n`;
          }

          return result;
        }

        // ── Read ─────────────────────────────────────────────
        case "read": {
          if (!messageId) return "Error: messageId is required for read.";

          const res = await googleFetch(`${GMAIL_BASE}/messages/${messageId}?format=full`, config);
          if (!res.ok) {
            if (res.status === 404) return `Error: email not found (ID: ${messageId}).`;
            return `Error: failed to read email (${res.status}).`;
          }

          const msg = (await res.json()) as GmailMessage;
          const headers = msg.payload.headers;
          const bodyText = extractBody(msg.payload);

          let result = `Subject: ${getHeader(headers, "Subject") || "(no subject)"}\n`;
          result += `From: ${getHeader(headers, "From")}\n`;
          result += `To: ${getHeader(headers, "To")}\n`;
          const ccVal = getHeader(headers, "Cc");
          if (ccVal) result += `CC: ${ccVal}\n`;
          result += `Date: ${formatDate(getHeader(headers, "Date"))}\n`;
          result += `Labels: ${msg.labelIds?.join(", ") ?? "none"}\n`;
          result += `\n--- Body ---\n${bodyText.slice(0, 4000)}`;
          if (bodyText.length > 4000) result += "\n\n(body truncated — very long email)";

          return result;
        }

        // ── Send ─────────────────────────────────────────────
        case "send": {
          if (!to) return "Error: to is required for send.";
          if (!subject) return "Error: subject is required for send.";
          if (!body) return "Error: body is required for send.";

          const raw = base64url(buildRawMessage({ to, subject, body, cc }));
          const res = await googleFetch(`${GMAIL_BASE}/messages/send`, config, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ raw }),
          });

          if (!res.ok) return `Error: failed to send email (${res.status}).`;
          const sent = (await res.json()) as { id: string; threadId: string };
          return `Email sent to ${to}.\nSubject: ${subject}\nMessage ID: ${sent.id}`;
        }

        // ── Reply ────────────────────────────────────────────
        case "reply": {
          if (!messageId) return "Error: messageId is required for reply.";
          if (!body) return "Error: body is required for reply.";

          // Fetch original to get threadId, headers
          const origRes = await googleFetch(
            `${GMAIL_BASE}/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID&metadataHeaders=To`,
            config,
          );
          if (!origRes.ok) return `Error: could not fetch original email (${origRes.status}).`;

          const orig = (await origRes.json()) as {
            id: string;
            threadId: string;
            payload: { headers: { name: string; value: string }[] };
          };

          const origHeaders = orig.payload.headers;
          const replyTo = getHeader(origHeaders, "From");
          const origSubject = getHeader(origHeaders, "Subject");
          const origMessageId = getHeader(origHeaders, "Message-ID");

          const replySubject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;

          const raw = base64url(
            buildRawMessage({
              to: to || replyTo,
              subject: replySubject,
              threadSubject: replySubject,
              body,
              cc,
              inReplyTo: origMessageId,
              references: origMessageId,
            }),
          );

          const res = await googleFetch(`${GMAIL_BASE}/messages/send`, config, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ raw, threadId: orig.threadId }),
          });

          if (!res.ok) return `Error: failed to send reply (${res.status}).`;
          const sent = (await res.json()) as { id: string };
          return `Reply sent to ${to || replyTo}.\nSubject: ${replySubject}\nMessage ID: ${sent.id}`;
        }

        // ── Forward ──────────────────────────────────────────
        case "forward": {
          if (!messageId) return "Error: messageId is required for forward.";
          if (!to) return "Error: to is required for forward.";

          // Fetch the original email
          const origRes = await googleFetch(`${GMAIL_BASE}/messages/${messageId}?format=full`, config);
          if (!origRes.ok) return `Error: could not fetch email to forward (${origRes.status}).`;

          const orig = (await origRes.json()) as GmailMessage;
          const origHeaders = orig.payload.headers;
          const origFrom = getHeader(origHeaders, "From");
          const origDate = getHeader(origHeaders, "Date");
          const origSubject = getHeader(origHeaders, "Subject");
          const origTo = getHeader(origHeaders, "To");
          const origBody = extractBody(orig.payload);

          const fwdBody = [
            body ?? "",
            "",
            "---------- Forwarded message ----------",
            `From: ${origFrom}`,
            `Date: ${origDate}`,
            `Subject: ${origSubject}`,
            `To: ${origTo}`,
            "",
            origBody,
          ].join("\n");

          const fwdSubject = origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`;

          const raw = base64url(buildRawMessage({ to, subject: fwdSubject, body: fwdBody }));
          const res = await googleFetch(`${GMAIL_BASE}/messages/send`, config, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ raw }),
          });

          if (!res.ok) return `Error: failed to forward email (${res.status}).`;
          const sent = (await res.json()) as { id: string };
          return `Email forwarded to ${to}.\nSubject: ${fwdSubject}\nMessage ID: ${sent.id}`;
        }

        // ── Labels ───────────────────────────────────────────
        case "labels": {
          const res = await googleFetch(`${GMAIL_BASE}/labels`, config);
          if (!res.ok) return `Error: failed to fetch labels (${res.status}).`;

          const data = (await res.json()) as {
            labels: {
              id: string;
              name: string;
              type: string;
              messagesTotal?: number;
              messagesUnread?: number;
            }[];
          };

          const system = data.labels.filter((l) => l.type === "system");
          const user = data.labels.filter((l) => l.type === "user");

          let result = "Gmail Labels:\n\nSystem labels:\n";
          for (const l of system) {
            result += `  ${l.name} (${l.messagesTotal ?? "?"} messages, ${l.messagesUnread ?? 0} unread)\n`;
          }

          if (user.length > 0) {
            result += "\nUser labels:\n";
            for (const l of user) {
              result += `  ${l.name}\n`;
            }
          }

          return result;
        }

        // ── Modify ─────────────────────────────────────────
        case "modify": {
          if (!messageId) return "Error: messageId is required for modify.";
          if (!addLabels && !removeLabels) return "Error: at least one of addLabels or removeLabels is required for modify.";

          const payload: { addLabelIds?: string[]; removeLabelIds?: string[] } = {};
          if (addLabels) payload.addLabelIds = addLabels.split(",").map((l) => l.trim());
          if (removeLabels) payload.removeLabelIds = removeLabels.split(",").map((l) => l.trim());

          const res = await googleFetch(`${GMAIL_BASE}/messages/${messageId}/modify`, config, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            if (res.status === 404) return `Error: email not found (ID: ${messageId}).`;
            const errBody = await res.text();
            return `Error: failed to modify email (${res.status}): ${errBody.slice(0, 300)}`;
          }

          const modified = (await res.json()) as { id: string; labelIds: string[] };
          const parts: string[] = [];
          if (addLabels) parts.push(`added: ${addLabels}`);
          if (removeLabels) parts.push(`removed: ${removeLabels}`);
          return `Email modified (${parts.join(", ")}).\nCurrent labels: ${modified.labelIds.join(", ")}\nMessage ID: ${modified.id}`;
        }

        // ── Draft ────────────────────────────────────────────
        case "draft": {
          if (!to) return "Error: to is required for draft.";
          if (!subject) return "Error: subject is required for draft.";
          if (!body) return "Error: body is required for draft.";

          const raw = base64url(buildRawMessage({ to, subject, body, cc }));
          const res = await googleFetch(`${GMAIL_BASE}/drafts`, config, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: { raw } }),
          });

          if (!res.ok) return `Error: failed to create draft (${res.status}).`;
          const draft = (await res.json()) as { id: string; message: { id: string } };
          return `Draft created.\nTo: ${to}\nSubject: ${subject}\nDraft ID: ${draft.id}`;
        }

        default:
          return `Error: unknown action "${action}". Use: search, read, send, reply, forward, labels, modify, draft.`;
      }
    } catch (err) {
      resetGoogleToken();
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Gmail tool error:", msg);
      return `Error: Gmail operation failed: ${msg}`;
    }
  },
});

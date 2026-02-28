import type { Message } from "discord.js";
import type OpenAI from "openai";

type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

/** The union type accepted by getLLMResponse. */
export type UserContent = string | ContentPart[];

// Extensions we can download and inline as text
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".ts", ".js", ".py", ".rs", ".go",
  ".java", ".c", ".cpp", ".h", ".hpp", ".css", ".html", ".xml",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".sh", ".bash",
  ".sql", ".csv", ".log",
]);

// MIME types that vision models can handle
const IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

const MAX_TEXT_FILE_SIZE = 100_000; // 100 KB
const MAX_IMAGE_SIZE = 20_000_000; // 20 MB

// Models known NOT to support vision — everything else is assumed vision-capable.
const TEXT_ONLY_MODEL_PATTERNS = [
  "gpt-3.5", "gpt-4-0314", "gpt-4-0613", // legacy OpenAI text-only
];

function isVisionModel(model: string): boolean {
  const lower = model.toLowerCase();
  return !TEXT_ONLY_MODEL_PATTERNS.some((p) => lower.includes(p));
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

/**
 * Process message attachments into LLM-ready content.
 * Returns a plain string when there are no image parts,
 * or a ContentPart[] when images need to be included.
 */
export async function processAttachments(
  message: Message,
  textContent: string,
  model: string,
): Promise<UserContent> {
  if (message.attachments.size === 0) return textContent;

  const imageParts: ContentPart[] = [];
  const textParts: string[] = [];
  const visionEnabled = isVisionModel(model);

  if (textContent) {
    textParts.push(textContent);
  }

  for (const [, attachment] of message.attachments) {
    const ext = getExtension(attachment.name ?? "");
    const mime = attachment.contentType ?? "";

    if (visionEnabled && IMAGE_MIME_TYPES.has(mime)) {
      if (attachment.size > MAX_IMAGE_SIZE) {
        textParts.push(
          `[Attached image "${attachment.name}" is too large (${(attachment.size / 1024 / 1024).toFixed(1)} MB, limit ${MAX_IMAGE_SIZE / 1024 / 1024} MB)]`,
        );
        continue;
      }
      try {
        const resp = await fetch(attachment.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
        imageParts.push({
          type: "image_url",
          image_url: { url: dataUri, detail: "auto" },
        });
      } catch (err) {
        textParts.push(
          `[Failed to download image "${attachment.name}": ${String(err)}]`,
        );
      }
    } else if (TEXT_EXTENSIONS.has(ext)) {
      if (attachment.size > MAX_TEXT_FILE_SIZE) {
        textParts.push(
          `[Attached file "${attachment.name}" is too large (${(attachment.size / 1024).toFixed(0)} KB, limit ${MAX_TEXT_FILE_SIZE / 1024} KB)]`,
        );
        continue;
      }

      try {
        const resp = await fetch(attachment.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const fileContent = await resp.text();
        textParts.push(
          `--- Attached file: ${attachment.name} ---\n${fileContent}\n--- End of ${attachment.name} ---`,
        );
      } catch (err) {
        textParts.push(
          `[Failed to download "${attachment.name}": ${String(err)}]`,
        );
      }
    } else {
      textParts.push(
        `[Attached file: "${attachment.name}" (${mime || "unknown type"}, ${(attachment.size / 1024).toFixed(1)} KB) — cannot be processed]`,
      );
    }
  }

  // No images — return as a simple string (backward compatible)
  if (imageParts.length === 0) {
    return textParts.join("\n\n");
  }

  // Mix text + images as content parts
  const parts: ContentPart[] = [];
  if (textParts.length > 0) {
    parts.push({ type: "text", text: textParts.join("\n\n") });
  }
  parts.push(...imageParts);
  return parts;
}

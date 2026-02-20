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

const VISION_MODEL_PATTERNS = [
  "gpt-4o", "gpt-4-vision", "gpt-4-turbo",
  "claude-3", "gemini",
];

function isVisionModel(model: string): boolean {
  const lower = model.toLowerCase();
  return VISION_MODEL_PATTERNS.some((p) => lower.includes(p));
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
      imageParts.push({
        type: "image_url",
        image_url: { url: attachment.url, detail: "auto" },
      });
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

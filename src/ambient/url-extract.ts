/**
 * URL content extraction for ambient context.
 * Fetches and extracts readable text from URLs shared in conversations.
 */

import type { BufferedMessage } from "./buffer.js";

const URL_REGEX = /https?:\/\/[^\s<>)"']+/g;
const DISCORD_CDN = /^https?:\/\/(cdn|media)\.discord(app)?\.com\//;
const MAX_URLS_PER_EVAL = 3;
const MAX_CONTENT_CHARS = 1000;
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

type CachedContent = { content: string; fetchedAt: number };
const cache = new Map<string, CachedContent>();

function pruneCache(): void {
  const now = Date.now();
  for (const [url, entry] of cache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS) cache.delete(url);
  }
}

function stripHtml(html: string): string {
  // Remove script/style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common entities
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

async function fetchUrlContent(url: string): Promise<string | null> {
  // Check cache
  const cached = cache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.content;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AeloraBot/1.0)" },
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/json")) {
      return null; // skip binary content
    }

    const raw = await response.text();
    const text = contentType.includes("text/html") ? stripHtml(raw) : raw;
    const trimmed = text.slice(0, MAX_CONTENT_CHARS);

    cache.set(url, { content: trimmed, fetchedAt: Date.now() });
    return trimmed;
  } catch {
    return null;
  }
}

/** Extract readable content from URLs found in recent messages. */
export async function extractUrlContent(messages: BufferedMessage[]): Promise<Map<string, string>> {
  pruneCache();

  const results = new Map<string, string>();
  const urls: string[] = [];

  for (const msg of messages) {
    if (msg.isBot) continue;
    const matches = msg.content.match(URL_REGEX);
    if (!matches) continue;
    for (const url of matches) {
      if (DISCORD_CDN.test(url)) continue; // skip Discord attachments
      if (!urls.includes(url)) urls.push(url);
      if (urls.length >= MAX_URLS_PER_EVAL) break;
    }
    if (urls.length >= MAX_URLS_PER_EVAL) break;
  }

  const fetches = urls.map(async (url) => {
    const content = await fetchUrlContent(url);
    if (content && content.length > 50) {
      results.set(url, content);
    }
  });

  await Promise.all(fetches);
  return results;
}

/**
 * Auto-extract noteworthy facts from conversations and save them to memory.
 * Follows the same lightweight fire-and-forget pattern as mood.ts.
 */

import { getLLMClient, getLLMModel, stripThinkBlocks } from "./llm.js";
import { saveFact, searchFacts } from "./memory.js";

// ── Throttle state (per-channel) ─────────────────────────

const lastExtraction = new Map<string, number>();
const channelMessageCount = new Map<string, number>();

const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between extractions per channel
const MIN_MESSAGES = 4; // minimum messages since last extraction

// ── Extraction prompt ────────────────────────────────────

const EXTRACT_SYSTEM =
  "Extract important facts from this conversation snippet. Reply with ONLY raw JSON, no explanation, no reasoning, no markdown.\n\n" +
  "Extract facts that would be useful to remember for future conversations:\n" +
  "- User preferences, opinions, or tastes\n" +
  "- Personal details (name, location, job, projects, pets, etc.)\n" +
  "- Decisions made or plans committed to\n" +
  "- Technical context (what they're working on, tools they use)\n" +
  "- Relationship dynamics or recurring topics\n\n" +
  "Rules:\n" +
  "- Only extract facts that are clearly stated or strongly implied, not speculation\n" +
  "- Each fact must be a short, self-contained statement (under 200 chars)\n" +
  '- If no noteworthy facts exist, return empty arrays\n\n' +
  'Response format:\n{"user_facts":["fact1","fact2"],"channel_facts":["fact3"],"global_facts":["fact4"]}';

// ── Public API ───────────────────────────────────────────

/** Increment the per-channel message counter. Call on every user message. */
export function trackMessage(channelId: string): void {
  channelMessageCount.set(channelId, (channelMessageCount.get(channelId) ?? 0) + 1);
}

/**
 * Extract facts from the latest exchange and save to memory.
 * Skips if throttle conditions aren't met.
 */
export async function extractFacts(
  userMessage: string,
  botResponse: string,
  channelId: string,
  userId?: string,
): Promise<void> {
  // Throttle: cooldown
  const now = Date.now();
  const lastTime = lastExtraction.get(channelId) ?? 0;
  if (now - lastTime < COOLDOWN_MS) return;

  // Throttle: message count
  const msgCount = channelMessageCount.get(channelId) ?? 0;
  if (msgCount < MIN_MESSAGES) return;

  // Reset counters
  channelMessageCount.set(channelId, 0);
  lastExtraction.set(channelId, now);

  const client = getLLMClient();
  const model = getLLMModel();

  const snippet = `User: ${userMessage.slice(0, 500)}\n\nBot: ${botResponse.slice(0, 500)}`;

  try {
    const result = await (client.chat.completions.create as Function)({
      model,
      max_completion_tokens: 400,
      enable_thinking: false,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: `/no_think\n${snippet}` },
      ],
    });

    const rawContent = stripThinkBlocks(result.choices[0]?.message?.content?.trim() ?? "");
    if (!rawContent) return;

    // Extract the first balanced JSON object from response
    const jsonStr = extractJson(rawContent);
    if (!jsonStr) {
      console.warn("FactExtractor: no JSON found in response:", rawContent.slice(0, 100));
      return;
    }

    let parsed: { user_facts?: string[]; channel_facts?: string[]; global_facts?: string[] };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      console.warn("FactExtractor: failed to parse JSON:", jsonStr.slice(0, 100));
      return;
    }

    let saved = 0;

    // Save user-scoped facts (max 3 per extraction)
    if (userId && Array.isArray(parsed.user_facts)) {
      for (const fact of parsed.user_facts.slice(0, 3)) {
        if (typeof fact !== "string" || !fact.trim()) continue;
        if (isDuplicate(fact, `user:${userId}`)) continue;
        const result = saveFact(`user:${userId}`, fact.trim());
        if (result.success) saved++;
      }
    }

    // Save channel-scoped facts (max 2 per extraction)
    if (Array.isArray(parsed.channel_facts)) {
      for (const fact of parsed.channel_facts.slice(0, 2)) {
        if (typeof fact !== "string" || !fact.trim()) continue;
        if (isDuplicate(fact, `channel:${channelId}`)) continue;
        const result = saveFact(`channel:${channelId}`, fact.trim());
        if (result.success) saved++;
      }
    }

    // Save global facts (max 1 per extraction)
    if (Array.isArray(parsed.global_facts)) {
      for (const fact of parsed.global_facts.slice(0, 1)) {
        if (typeof fact !== "string" || !fact.trim()) continue;
        if (isDuplicate(fact, "global")) continue;
        const result = saveFact("global", fact.trim());
        if (result.success) saved++;
      }
    }

    if (saved > 0) {
      console.log(`FactExtractor: saved ${saved} fact(s) from channel ${channelId}`);
    }
  } catch (err) {
    console.warn("FactExtractor: extraction failed:", err);
  }
}

// ── JSON extraction ─────────────────────────────────────

/** Extract the first balanced top-level JSON object from text. */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ── Semantic dedup ───────────────────────────────────────

/**
 * Lightweight semantic dedup using keyword overlap (Jaccard similarity).
 * Returns true if a substantially similar fact already exists in the scope.
 */
function isDuplicate(newFact: string, scope: string): boolean {
  const newWords = significantWords(newFact);
  if (newWords.size === 0) return false;

  // Search existing facts for keyword matches
  const query = [...newWords].slice(0, 3).join(" ");
  const matches = searchFacts(query, [scope]);

  for (const match of matches) {
    const existingWords = significantWords(match.fact.fact);
    if (existingWords.size === 0) continue;

    // Jaccard similarity: intersection / union
    let intersection = 0;
    for (const word of newWords) {
      if (existingWords.has(word)) intersection++;
    }
    const union = new Set([...newWords, ...existingWords]).size;
    if (intersection / union > 0.6) return true;
  }

  return false;
}

/** Extract significant words (4+ chars, lowercase, no punctuation). */
function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

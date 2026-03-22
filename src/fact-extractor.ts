/**
 * Auto-extract noteworthy facts from conversations and save them to memory.
 * Follows the same lightweight fire-and-forget pattern as mood.ts.
 */

import type OpenAI from "openai";
import { getLLMClient, getAuxiliaryModel, getDisableThinking, stripThinkBlocks } from "./llm.js";
import { saveFact, getFacts, deleteFact, searchFactsKeyword } from "./memory.js";
import type { FactCategory, FactConfidence } from "./memory.js";
import { isDuplicateSemantic, isReady as isVectorReady, formatError } from "./vector-store.js";
import { getUser, updateUserSynthesis } from "./users.js";
import { broadcastEvent } from "./logger.js";

// ── Throttle state (per-channel) ─────────────────────────

const lastExtraction = new Map<string, number>();
const channelMessageCount = new Map<string, number>();

const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between extractions per channel
const MIN_MESSAGES = 4; // minimum messages since last extraction

// ── Synthesis thresholds ──────────────────────────────────

const SYNTHESIS_MIN_FACTS = 5;  // need at least this many facts before first synthesis
const SYNTHESIS_DELTA = 3;      // re-synthesize after this many new facts

// ── Extraction prompt ────────────────────────────────────

const EXTRACT_SYSTEM =
  "You are a JSON-only fact extractor. Output ONLY a single JSON object. No text before or after. No analysis. No explanation. No markdown. No reasoning. Just the JSON object.\n\n" +
  "Extract facts that would be useful to remember for future conversations:\n" +
  "- User preferences, opinions, or tastes\n" +
  "- Personal details (name, location, job, projects, pets, etc.)\n" +
  "- Decisions made or plans committed to\n" +
  "- Technical context (what they're working on, tools they use)\n" +
  "- Relationship dynamics or recurring topics\n" +
  "- Communication style and tone (how they write, humor, energy level, verbosity)\n" +
  "- Emotional patterns (what energizes or frustrates them, how they engage)\n\n" +
  "Each fact is an object with:\n" +
  '- "fact": short self-contained statement (under 200 chars)\n' +
  '- "category": one of "preference", "biographical", "behavioral", "relationship", "technical", "contextual"\n' +
  '- "confidence": "stated" (user explicitly said it) or "inferred" (implied from context)\n\n' +
  "Categories:\n" +
  '- preference: likes, dislikes, opinions, tastes\n' +
  '- biographical: name, location, job, age, pets, family\n' +
  '- behavioral: communication style, habits, patterns, tone\n' +
  '- relationship: dynamics with others, social context\n' +
  '- technical: tools, languages, projects, skills\n' +
  '- contextual: situational facts, current events, plans\n\n' +
  "Rules:\n" +
  "- Only extract facts that are clearly stated or strongly implied, not speculation\n" +
  "- If no noteworthy facts exist, return empty arrays\n" +
  '- If existing facts are provided, check for CONTRADICTIONS — facts that are mutually exclusive (e.g. changed preference, moved location, switched job). Only flag true contradictions, NOT additions.\n\n' +
  'Response format:\n' +
  '{"user_facts":[{"fact":"...","category":"preference","confidence":"stated"}],' +
  '"personality_facts":[{"fact":"...","category":"behavioral","confidence":"inferred"}],' +
  '"channel_facts":[{"fact":"...","category":"contextual","confidence":"stated"}],' +
  '"global_facts":[{"fact":"...","category":"contextual","confidence":"inferred"}],' +
  '"contradictions":[{"new_fact":"prefers Python","replaces":"prefers JavaScript"}]}';

// ── Synthesis prompt ──────────────────────────────────────

const SYNTHESIS_SYSTEM =
  "You are building a personality model for a personal AI companion. " +
  "Based on the facts provided about a user, write a 3-4 sentence personality profile " +
  "that captures who they are, how they communicate, what they care about, and their emotional style. " +
  "Start with 'You are talking to someone who...' " +
  "Be specific and personal, not generic. Keep it under 400 characters. " +
  "Reply with ONLY the profile text, no explanation or markdown.";

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
  const model = getAuxiliaryModel();

  let snippet = `User: ${userMessage.slice(0, 500)}\n\nBot: ${botResponse.slice(0, 500)}`;

  // Inject existing facts for contradiction detection
  const existingFacts: string[] = [];
  if (userId) {
    const userFacts = getFacts(`user:${userId}`).slice(-15);
    for (const f of userFacts) existingFacts.push(f.fact);
  }
  const channelFacts = getFacts(`channel:${channelId}`).slice(-10);
  for (const f of channelFacts) existingFacts.push(f.fact);
  if (existingFacts.length > 0) {
    snippet += `\n\nExisting facts (check for contradictions):\n${existingFacts.map((f) => `- ${f}`).join("\n")}`;
  }

  try {
    // Always suppress thinking for lightweight JSON extraction calls  - 
    // models like Qwen 3.5 burn all tokens on chain-of-thought otherwise
    const extractParams: Record<string, unknown> = {
      model,
      max_completion_tokens: 4096,
      ...(getDisableThinking() ? { enable_thinking: false } : {}),
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: getDisableThinking() ? `/no_think\n${snippet}` : snippet },
      ],
    };
    const result = await client.chat.completions.create(
      extractParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    );

    let rawContent = stripThinkBlocks(result.choices[0]?.message?.content?.trim() ?? "");
    if (!rawContent) return;

    // Strip markdown code fences that some models wrap JSON in
    rawContent = rawContent.replace(/^```(?:json)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();

    // Extract the first balanced JSON object from response
    const jsonStr = extractJson(rawContent);
    if (!jsonStr) {
      console.warn("FactExtractor: no JSON found in response:", rawContent.slice(0, 100));
      return;
    }

    type FactEntry = string | { fact: string; category?: string; confidence?: string };
    type Contradiction = { new_fact: string; replaces: string };
    type ParsedExtraction = {
      user_facts?: FactEntry[];
      personality_facts?: FactEntry[];
      channel_facts?: FactEntry[];
      global_facts?: FactEntry[];
      contradictions?: Contradiction[];
    };

    let parsed: ParsedExtraction;
    try {
      parsed = JSON.parse(repairJson(jsonStr));
    } catch {
      // Fallback: try stripping everything outside the JSON structure more aggressively
      try {
        const cleaned = repairJson(jsonStr)
          .replace(/[\x00-\x1f]/g, " ")           // strip all control chars
          .replace(/\t/g, " ");                     // tabs to spaces
        parsed = JSON.parse(cleaned);
      } catch (parseErr2) {
        console.warn("FactExtractor: failed to parse JSON:", (parseErr2 as Error).message, "| input:", jsonStr.slice(0, 300));
        return;
      }
    }

    // Normalize a fact entry (string or object) into text + metadata
    function normalizeFact(entry: FactEntry): { text: string; category: FactCategory; confidence: FactConfidence } | null {
      if (typeof entry === "string") {
        const t = entry.trim();
        return t ? { text: t, category: "contextual", confidence: "inferred" } : null;
      }
      if (entry && typeof entry.fact === "string") {
        const t = entry.fact.trim();
        if (!t) return null;
        const validCategories: FactCategory[] = ["preference", "biographical", "behavioral", "relationship", "technical", "contextual"];
        const cat = validCategories.includes(entry.category as FactCategory) ? (entry.category as FactCategory) : "contextual";
        const conf: FactConfidence = entry.confidence === "stated" ? "stated" : "inferred";
        return { text: t, category: cat, confidence: conf };
      }
      return null;
    }

    // Process contradictions first — delete old facts that are being replaced
    if (Array.isArray(parsed.contradictions)) {
      for (const c of parsed.contradictions) {
        if (!c.replaces || typeof c.replaces !== "string") continue;
        const replacesLower = c.replaces.toLowerCase();
        // Check all relevant scopes for the old fact
        const scopesToCheck = ["global", `channel:${channelId}`];
        if (userId) scopesToCheck.push(`user:${userId}`);
        for (const scope of scopesToCheck) {
          const facts = getFacts(scope);
          for (let i = facts.length - 1; i >= 0; i--) {
            if (facts[i].fact.toLowerCase().includes(replacesLower) || replacesLower.includes(facts[i].fact.toLowerCase())) {
              console.log(`FactExtractor: contradiction — replacing "${facts[i].fact}" with "${c.new_fact}" in scope "${scope}"`);
              deleteFact(scope, i);
            }
          }
        }
      }
    }

    let saved = 0;
    const source = `channel:${channelId}`;

    // Save user-scoped facts (max 3 per extraction)
    if (userId && Array.isArray(parsed.user_facts)) {
      for (const entry of parsed.user_facts.slice(0, 3)) {
        const f = normalizeFact(entry);
        if (!f) continue;
        if (await isDuplicate(f.text, `user:${userId}`)) continue;
        const r = saveFact(`user:${userId}`, f.text, { category: f.category, confidence: f.confidence, source });
        if (r.success) saved++;
      }
    }

    // Save personality/style facts to user scope (max 2 per extraction)
    if (userId && Array.isArray(parsed.personality_facts)) {
      for (const entry of parsed.personality_facts.slice(0, 2)) {
        const f = normalizeFact(entry);
        if (!f) continue;
        // Personality facts default to behavioral if model didn't specify
        if (typeof entry !== "string" && !entry.category) f.category = "behavioral";
        if (await isDuplicate(f.text, `user:${userId}`)) continue;
        const r = saveFact(`user:${userId}`, f.text, { category: f.category, confidence: f.confidence, source });
        if (r.success) saved++;
      }
    }

    // Save channel-scoped facts (max 2 per extraction)
    if (Array.isArray(parsed.channel_facts)) {
      for (const entry of parsed.channel_facts.slice(0, 2)) {
        const f = normalizeFact(entry);
        if (!f) continue;
        if (await isDuplicate(f.text, `channel:${channelId}`)) continue;
        const r = saveFact(`channel:${channelId}`, f.text, { category: f.category, confidence: f.confidence, source });
        if (r.success) saved++;
      }
    }

    // Save global facts (max 1 per extraction)
    if (Array.isArray(parsed.global_facts)) {
      for (const entry of parsed.global_facts.slice(0, 1)) {
        const f = normalizeFact(entry);
        if (!f) continue;
        if (await isDuplicate(f.text, "global")) continue;
        const r = saveFact("global", f.text, { category: f.category, confidence: f.confidence, source });
        if (r.success) saved++;
      }
    }

    if (saved > 0) {
      console.log(`FactExtractor: saved ${saved} fact(s) from channel ${channelId}`);
      const allSavedFacts: string[] = [];
      for (const arr of [parsed.user_facts, parsed.personality_facts, parsed.channel_facts, parsed.global_facts]) {
        if (Array.isArray(arr)) {
          for (const e of arr) {
            const t = typeof e === "string" ? e : e?.fact;
            if (t) allSavedFacts.push(t.slice(0, 80));
          }
        }
      }
      broadcastEvent("mindmap", {
        type: "fact:extracted", conversationId: channelId,
        count: saved, facts: allSavedFacts.slice(0, 8),
        contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions.length : 0,
        timestamp: new Date().toISOString(),
      });
    }

    // Trigger personality synthesis if enough new facts have accumulated
    if (userId) {
      const totalFacts = getFacts(`user:${userId}`).length;
      const profile = getUser(userId);
      const factsAtLast = profile?.factCountAtSynthesis ?? 0;
      if (totalFacts >= SYNTHESIS_MIN_FACTS && totalFacts - factsAtLast >= SYNTHESIS_DELTA) {
        synthesizeUserPersonality(userId, totalFacts).catch((err) =>
          console.warn("FactExtractor: personality synthesis failed:", err),
        );
      }
    }
  } catch (err) {
    console.warn("FactExtractor: extraction failed:", err);
  }
}

// ── Personality synthesis ────────────────────────────────

/**
 * Synthesize all known facts about a user into a compact personality profile.
 * Stored on UserProfile.personalitySummary and injected into the system prompt.
 */
async function synthesizeUserPersonality(userId: string, factCount: number): Promise<void> {
  const facts = getFacts(`user:${userId}`);
  if (facts.length === 0) return;

  const factList = facts.map((f) => `- ${f.fact}`).join("\n");

  const client = getLLMClient();
  const model = getAuxiliaryModel();

  const userContent = `Facts about this user:\n${factList}`;

  const synthesisParams: Record<string, unknown> = {
    model,
    max_completion_tokens: 4096,
    ...(getDisableThinking() ? { enable_thinking: false } : {}),
    messages: [
      { role: "system", content: SYNTHESIS_SYSTEM },
      { role: "user", content: getDisableThinking() ? `/no_think\n${userContent}` : userContent },
    ],
  };
  const result = await client.chat.completions.create(
    synthesisParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  );

  const summary = stripThinkBlocks(result.choices[0]?.message?.content?.trim() ?? "");
  if (!summary) return;

  updateUserSynthesis(userId, summary, factCount);
  console.log(`FactExtractor: synthesized personality profile for user ${userId}`);
}

// ── JSON extraction ─────────────────────────────────────

/** Fix common LLM JSON mistakes that survive extractJson but fail JSON.parse. */
function repairJson(json: string): string {
  let s = json;
  // Replace lazy placeholder [...] with empty arrays
  s = s.replace(/\[\s*\.\.\.\s*\]/g, "[]");
  // Remove trailing commas before ] or }
  s = s.replace(/,(\s*[}\]])/g, "$1");
  // Remove single-line comments (// ...) outside of strings
  s = s.replace(/(?<=[:,\[\{}\]]\s*)\/\/[^\n]*/g, "");
  // Replace single-quoted strings with double-quoted, but ONLY if
  // the JSON uses single quotes as delimiters (no double-quoted keys found).
  // Otherwise these regexes match single quotes inside double-quoted strings
  // and corrupt the JSON (e.g. "concise, 'super tight' summaries" → broken).
  const usesDoubleQuotedKeys = /"\w+"[\s]*:/.test(s);
  if (!usesDoubleQuotedKeys) {
    s = s.replace(/:\s*'([^']*?)'/g, ': "$1"');
    s = s.replace(/\[\s*'([^']*?)'/g, '["$1"');
    s = s.replace(/,\s*'([^']*?)'/g, ', "$1"');
  }
  return s;
}

/**
 * Extract the first balanced top-level JSON object from text, sanitizing
 * literal control characters inside strings (LLMs often embed raw newlines
 * in string values, which makes JSON.parse throw).
 */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      out.push(ch);
      continue;
    }
    if (ch === "\\") {
      escape = inString;
      out.push(ch);
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out.push(ch);
      continue;
    }
    if (inString) {
      const code = ch.charCodeAt(0);
      // Escape/drop all control characters invalid inside JSON strings (U+0000–U+001F)
      if (code < 0x20) {
        if (code === 0x09) { out.push("\\t"); continue; }   // tab
        if (code === 0x0a) { out.push("\\n"); continue; }   // newline
        if (code === 0x0d) { out.push("\\r"); continue; }   // carriage return
        // All other control chars are just dropped  -  they shouldn't be in facts
        continue;
      }
      out.push(ch);
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        out.push(ch);
        return out.join("");
      }
    }
    out.push(ch);
  }
  return null;
}

// ── Semantic dedup ───────────────────────────────────────

/**
 * Lightweight semantic dedup using keyword overlap (Jaccard similarity).
 * Returns true if a substantially similar fact already exists in the scope.
 */
async function isDuplicate(newFact: string, scope: string): Promise<boolean> {
  // Use vector-based semantic dedup when available
  if (isVectorReady()) {
    try {
      return await isDuplicateSemantic(newFact, scope);
    } catch (err) {
      console.warn("FactExtractor: semantic dedup failed, falling back to Jaccard:", formatError(err));
    }
  }

  // Jaccard fallback
  const newWords = significantWords(newFact);
  if (newWords.size === 0) return false;

  const query = [...newWords].slice(0, 3).join(" ");
  const matches = searchFactsKeyword(query, [scope]);

  for (const match of matches) {
    const existingWords = significantWords(match.fact.fact);
    if (existingWords.size === 0) continue;

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

/**
 * Heartbeat handler: periodically consolidates related facts within a scope
 * into fewer, richer statements using an LLM merge pass.
 */

import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { getFacts, deleteFact, saveFact, setOnFactAdded } from "./memory.js";
import type { FactCategory, FactConfidence, MemoryFact } from "./memory.js";
import { getLLMClient, getAuxiliaryModel, getDisableThinking, stripThinkBlocks } from "./llm.js";
import { indexFact, removeFact, isReady as isVectorReady } from "./vector-store.js";
import type OpenAI from "openai";

// ── Per-scope counters ──────────────────────────────────

const factsAddedSince = new Map<string, number>();
let consolidationThreshold = 10;
let consolidationEnabled = true;

const CONSOLIDATION_PROMPT =
  "You are a fact consolidation engine. Given a list of related facts about the same topic, " +
  "merge them into fewer, richer statements. Preserve ALL specific details — names, numbers, dates, tools, preferences.\n\n" +
  "Categories: preference, biographical, behavioral, relationship, technical, contextual, " +
  "task, goal, sentiment, life_event, social, opinion\n\n" +
  "Rules:\n" +
  "- Only merge facts that are truly related and can be combined without losing information\n" +
  "- If facts are unrelated, leave them as-is (don't include their indices in consumed)\n" +
  "- Each merged fact should be under 200 characters\n" +
  "- Preserve the most specific category and highest confidence from the merged facts\n" +
  "- NEVER merge task facts with different dates/deadlines — each task is distinct\n" +
  "- For sentiment facts about the same topic, merge into a trend (e.g. 'consistently frustrated with X')\n" +
  "- Preserve any temporal metadata (expiresAt, relevantDate) from the most relevant source fact\n\n" +
  "Output ONLY a JSON object, no other text:\n" +
  '{"merged":[{"fact":"...","category":"preference","confidence":"stated"}],"consumed":[0,2,4]}\n\n' +
  "consumed = zero-indexed positions of input facts that were merged into the new statements.\n" +
  "If nothing can be merged, return: {\"merged\":[],\"consumed\":[]}";

// ── Public config ───────────────────────────────────────

export function configureConsolidation(opts: { enabled: boolean; threshold: number }): void {
  consolidationEnabled = opts.enabled;
  consolidationThreshold = opts.threshold;
}

// ── Tracking callback ───────────────────────────────────

function trackFactAdded(scope: string): void {
  factsAddedSince.set(scope, (factsAddedSince.get(scope) ?? 0) + 1);
}

// ── Consolidation logic ─────────────────────────────────

async function consolidateScope(scope: string): Promise<string | void> {
  const facts = getFacts(scope);
  if (facts.length < 8) return; // not enough to bother

  // Group by category, only consolidate categories with 4+ facts
  const byCategory = new Map<string, { fact: MemoryFact; originalIndex: number }[]>();
  for (let i = 0; i < facts.length; i++) {
    const cat = facts[i].category ?? "contextual";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push({ fact: facts[i], originalIndex: i });
  }

  let totalMerged = 0;
  let totalConsumed = 0;

  for (const [category, entries] of byCategory) {
    if (entries.length < 4) continue;

    const factList = entries.map((e, i) => `${i}. ${e.fact.fact}`).join("\n");
    const userContent = `Category: ${category}\nScope: ${scope}\n\nFacts:\n${factList}`;

    const client = getLLMClient();
    const model = getAuxiliaryModel();

    try {
      const params: Record<string, unknown> = {
        model,
        max_completion_tokens: 4096,
        ...(getDisableThinking() ? { enable_thinking: false } : {}),
        messages: [
          { role: "system", content: CONSOLIDATION_PROMPT },
          { role: "user", content: getDisableThinking() ? `/no_think\n${userContent}` : userContent },
        ],
      };

      const result = await client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      );

      let rawContent = stripThinkBlocks(result.choices[0]?.message?.content?.trim() ?? "");
      if (!rawContent) continue;

      // Strip markdown fences
      rawContent = rawContent.replace(/^```(?:json)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();

      const parsed: {
        merged: { fact: string; category?: string; confidence?: string }[];
        consumed: number[];
      } = JSON.parse(rawContent);

      if (!Array.isArray(parsed.merged) || !Array.isArray(parsed.consumed) || parsed.consumed.length === 0) {
        continue;
      }

      // Delete consumed facts in reverse order (to preserve indices)
      const consumedIndices = parsed.consumed
        .filter((i) => i >= 0 && i < entries.length)
        .map((i) => entries[i].originalIndex)
        .sort((a, b) => b - a); // reverse order

      const consumedFacts = consumedIndices.map((i) => facts[i]);

      for (const idx of consumedIndices) {
        deleteFact(scope, idx);
      }

      // Remove from vector store
      if (isVectorReady()) {
        for (const f of consumedFacts) {
          removeFact(scope, f.fact).catch(() => {});
        }
      }

      // Save merged facts
      const newestSavedAt = consumedFacts
        .map((f) => f.savedAt)
        .sort()
        .pop() ?? new Date().toISOString();

      for (const m of parsed.merged) {
        if (!m.fact || typeof m.fact !== "string") continue;
        const validCategories: FactCategory[] = [
          "preference", "biographical", "behavioral", "relationship", "technical", "contextual",
          "task", "goal", "sentiment", "life_event", "social", "opinion",
        ];
        const cat = validCategories.includes(m.category as FactCategory) ? (m.category as FactCategory) : (category as FactCategory);
        const conf: FactConfidence = m.confidence === "stated" ? "stated" : "inferred";

        saveFact(scope, m.fact.trim(), {
          category: cat,
          confidence: conf,
          source: "consolidation",
        });

        totalMerged++;
      }

      totalConsumed += consumedIndices.length;
    } catch (err) {
      console.warn(`Consolidation: failed for ${scope}/${category}:`, err);
    }
  }

  if (totalConsumed > 0) {
    return `consolidated ${scope}: ${totalConsumed} facts → ${totalMerged} merged`;
  }
}

// ── Heartbeat handler ───────────────────────────────────

const consolidationHandler: HeartbeatHandler = {
  name: "fact-consolidation",
  description: "Merges related facts into richer statements when a scope accumulates enough new facts",
  enabled: true,

  execute: async () => {
    if (!consolidationEnabled) return;

    // Find the first scope that exceeds the threshold
    for (const [scope, count] of factsAddedSince) {
      if (count >= consolidationThreshold) {
        factsAddedSince.set(scope, 0);
        return consolidateScope(scope);
      }
    }
  },
};

export function registerConsolidation(): void {
  setOnFactAdded(trackFactAdded);
  registerHeartbeatHandler(consolidationHandler);
}

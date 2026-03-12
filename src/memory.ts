import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as vectorStore from "./vector-store.js";
import type { VectorStoreConfig } from "./vector-store.js";

const MEMORY_FILE = "data/memory.json";

// Defaults  -  overridden by configureMemory() after config loads
let maxFactsPerScope = 100;
let maxFactLength = 1000;
let vectorEnabled = false;

export interface MemoryConfig {
  maxFactsPerScope?: number;
  maxFactLength?: number;
  vector?: VectorStoreConfig;
}

/** Apply config overrides. Call after config is loaded. */
export async function configureMemory(opts: MemoryConfig): Promise<void> {
  if (opts.maxFactsPerScope) maxFactsPerScope = opts.maxFactsPerScope;
  if (opts.maxFactLength) maxFactLength = opts.maxFactLength;

  if (opts.vector) {
    vectorEnabled = await vectorStore.initVectorStore(opts.vector);

    // Auto-migrate if vector store is new and we have existing facts
    if (vectorEnabled) {
      const stats = await vectorStore.getIndexStats();
      const totalFacts = Object.values(store).reduce((sum, facts) => sum + facts.length, 0);
      if (stats && stats.items === 0 && totalFacts > 0) {
        console.log("Memory: auto-migrating existing facts to vector index...");
        const result = await vectorStore.rebuildIndex(store);
        console.log(`Memory: auto-migration complete — ${result.indexed} indexed, ${result.errors} errors`);
      }
    }
  }
}

// Prompt injection caps  -  keep system prompt bounded (more available via memory search tool)
const MAX_GLOBAL_INJECTED = 5;
const MAX_SCOPED_INJECTED = 8;

type MemoryFact = {
  fact: string;
  savedAt: string;
};

type MemoryStore = Record<string, MemoryFact[]>;

let store: MemoryStore = {};

function load(): void {
  try {
    if (existsSync(MEMORY_FILE)) {
      store = JSON.parse(readFileSync(MEMORY_FILE, "utf-8"));
    }
  } catch {
    store = {};
  }
}

function save(): void {
  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error("Memory: failed to save:", err);
  }
}

export function saveFact(scope: string, fact: string): { success: boolean; error?: string } {
  const trimmed = fact.trim().slice(0, maxFactLength);
  if (!trimmed) return { success: false, error: "Fact cannot be empty" };

  if (!store[scope]) store[scope] = [];

  // Check for duplicates
  if (store[scope].some((f) => f.fact === trimmed)) {
    return { success: false, error: "Duplicate fact  -  already remembered" };
  }

  const savedAt = new Date().toISOString();
  store[scope].push({ fact: trimmed, savedAt });

  // Cap at max
  if (store[scope].length > maxFactsPerScope) {
    store[scope] = store[scope].slice(-maxFactsPerScope);
  }

  save();
  console.log(`Memory: saved fact to "${scope}" (${store[scope].length} total)`);

  // Fire-and-forget vector indexing
  if (vectorEnabled) {
    vectorStore.indexFact(scope, trimmed, savedAt).catch((err) => {
      console.warn("Memory: vector indexing failed:", err);
    });
  }

  return { success: true };
}

export function getFacts(scope: string): MemoryFact[] {
  return store[scope] ?? [];
}

export function deleteFact(scope: string, index: number): boolean {
  const facts = store[scope];
  if (!facts || index < 0 || index >= facts.length) return false;

  const removed = facts[index];
  facts.splice(index, 1);
  if (facts.length === 0) delete store[scope];
  save();
  console.log(`Memory: deleted fact from "${scope}" (index ${index})`);

  // Fire-and-forget vector removal
  if (vectorEnabled) {
    vectorStore.removeFact(scope, removed.fact).catch((err) => {
      console.warn("Memory: vector removal failed:", err);
    });
  }

  return true;
}

export function clearScope(scope: string): number {
  const facts = store[scope];
  if (!facts) return 0;
  const count = facts.length;
  delete store[scope];
  save();
  console.log(`Memory: cleared scope "${scope}" (${count} facts removed)`);

  // Fire-and-forget vector scope removal
  if (vectorEnabled) {
    vectorStore.removeScope(scope).catch((err) => {
      console.warn("Memory: vector scope removal failed:", err);
    });
  }

  return count;
}

export function getAllMemory(): MemoryStore {
  return { ...store };
}

/**
 * Search facts by keyword (legacy) or semantically via vector search.
 * Returns matching facts with their scope and index.
 */
export async function searchFacts(
  query: string,
  scopes?: string[],
): Promise<{ scope: string; index: number; fact: MemoryFact; score?: number }[]> {
  // Try semantic search first
  if (vectorEnabled) {
    try {
      const results = await vectorStore.semanticSearch(query, { scopes });
      // Map back to the original store indices
      return results.map((r) => {
        const scopeFacts = store[r.scope] ?? [];
        const idx = scopeFacts.findIndex((f) => f.fact === r.fact);
        return {
          scope: r.scope,
          index: idx >= 0 ? idx : 0,
          fact: { fact: r.fact, savedAt: r.savedAt },
          score: r.score,
        };
      });
    } catch (err) {
      console.warn("Memory: semantic search failed, falling back to keyword:", err);
    }
  }

  // Keyword fallback
  return searchFactsKeyword(query, scopes);
}

/** Original keyword-based search — used as fallback. */
export function searchFactsKeyword(
  query: string,
  scopes?: string[],
): { scope: string; index: number; fact: MemoryFact }[] {
  const results: { scope: string; index: number; fact: MemoryFact }[] = [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return results;

  for (const [scope, facts] of Object.entries(store)) {
    if (scopes && scopes.length > 0 && !scopes.some((s) => scope.includes(s))) continue;
    for (let i = 0; i < facts.length; i++) {
      const lower = facts[i].fact.toLowerCase();
      if (terms.every((term) => lower.includes(term))) {
        results.push({ scope, index: i, fact: facts[i] });
      }
    }
  }

  return results;
}

/**
 * Build a formatted memory block for system prompt injection.
 * When vector search is available and conversationContext is provided,
 * selects the most relevant facts instead of the most recent.
 */
export async function getMemoryForPrompt(
  userId: string | null,
  channelId: string | null,
  conversationContext?: string,
): Promise<string> {
  const sections: string[] = [];

  if (vectorEnabled && conversationContext) {
    // Semantic relevance-based injection
    const scopes: string[] = ["global"];
    if (userId) scopes.push(`user:${userId}`);
    if (channelId) scopes.push(`channel:${channelId}`);

    try {
      const results = await vectorStore.semanticSearch(conversationContext, {
        scopes,
        topK: MAX_GLOBAL_INJECTED + MAX_SCOPED_INJECTED * 2,
        minScore: 0.25,
      });

      if (results.length > 0) {
        // Group by scope type
        const global: string[] = [];
        const user: string[] = [];
        const channel: string[] = [];

        for (const r of results) {
          if (r.scope === "global" && global.length < MAX_GLOBAL_INJECTED) {
            global.push(r.fact);
          } else if (r.scope.startsWith("user:") && user.length < MAX_SCOPED_INJECTED) {
            user.push(r.fact);
          } else if (r.scope.startsWith("channel:") && channel.length < MAX_SCOPED_INJECTED) {
            channel.push(r.fact);
          }
        }

        if (global.length > 0) {
          sections.push("### General knowledge");
          for (const f of global) sections.push(`- ${f}`);
          const totalGlobal = store["global"]?.length ?? 0;
          if (totalGlobal > global.length) {
            sections.push(`_(${totalGlobal - global.length} more global facts available via memory search)_`);
          }
        }
        if (user.length > 0) {
          sections.push("### About this user");
          for (const f of user) sections.push(`- ${f}`);
          const totalUser = userId ? (store[`user:${userId}`]?.length ?? 0) : 0;
          if (totalUser > user.length) {
            sections.push(`_(${totalUser - user.length} more user facts available via memory search)_`);
          }
        }
        if (channel.length > 0) {
          sections.push("### About this channel");
          for (const f of channel) sections.push(`- ${f}`);
          const totalChannel = channelId ? (store[`channel:${channelId}`]?.length ?? 0) : 0;
          if (totalChannel > channel.length) {
            sections.push(`_(${totalChannel - channel.length} more channel facts available via memory search)_`);
          }
        }

        if (sections.length > 0) {
          return "\n\n## Memory\n" + sections.join("\n");
        }
      }
    } catch (err) {
      console.warn("Memory: semantic prompt injection failed, falling back to recency:", err);
    }
  }

  // Recency-based fallback (original behavior)
  return getMemoryForPromptRecency(userId, channelId);
}

/** Original recency-based memory injection — used as fallback. */
function getMemoryForPromptRecency(userId: string | null, channelId: string | null): string {
  const sections: string[] = [];

  const globalFacts = store["global"];
  if (globalFacts && globalFacts.length > 0) {
    sections.push("### General knowledge");
    const recent = globalFacts.slice(-MAX_GLOBAL_INJECTED);
    for (const f of recent) sections.push(`- ${f.fact}`);
    if (globalFacts.length > MAX_GLOBAL_INJECTED) {
      sections.push(`_(${globalFacts.length - MAX_GLOBAL_INJECTED} more global facts available via memory search)_`);
    }
  }

  if (userId) {
    const userFacts = store[`user:${userId}`];
    if (userFacts && userFacts.length > 0) {
      sections.push("### About this user");
      const recent = userFacts.slice(-MAX_SCOPED_INJECTED);
      for (const f of recent) sections.push(`- ${f.fact}`);
      if (userFacts.length > MAX_SCOPED_INJECTED) {
        sections.push(`_(${userFacts.length - MAX_SCOPED_INJECTED} more user facts available via memory search)_`);
      }
    }
  }

  if (channelId) {
    const channelFacts = store[`channel:${channelId}`];
    if (channelFacts && channelFacts.length > 0) {
      sections.push("### About this channel");
      const recent = channelFacts.slice(-MAX_SCOPED_INJECTED);
      for (const f of recent) sections.push(`- ${f.fact}`);
      if (channelFacts.length > MAX_SCOPED_INJECTED) {
        sections.push(`_(${channelFacts.length - MAX_SCOPED_INJECTED} more channel facts available via memory search)_`);
      }
    }
  }

  if (sections.length === 0) return "";
  return "\n\n## Memory\n" + sections.join("\n");
}

/**
 * Remove facts older than maxAgeDays across all scopes.
 * Returns the number of facts pruned.
 */
export function pruneFacts(maxAgeDays: number): number {
  if (maxAgeDays <= 0) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let pruned = 0;
  const prunedFacts: { scope: string; fact: string }[] = [];

  for (const [scope, facts] of Object.entries(store)) {
    const before = facts.length;
    const kept: MemoryFact[] = [];
    for (const f of facts) {
      if (new Date(f.savedAt).getTime() >= cutoff) {
        kept.push(f);
      } else {
        prunedFacts.push({ scope, fact: f.fact });
      }
    }
    store[scope] = kept;
    pruned += before - kept.length;

    if (store[scope].length === 0) delete store[scope];
  }

  if (pruned > 0) {
    save();
    console.log(`Memory: pruned ${pruned} fact(s) older than ${maxAgeDays} days`);

    // Fire-and-forget vector removal for pruned facts
    if (vectorEnabled) {
      for (const { scope, fact } of prunedFacts) {
        vectorStore.removeFact(scope, fact).catch((err) => {
          console.warn("Memory: vector prune removal failed:", err);
        });
      }
    }
  }

  return pruned;
}

// Load from disk on module init
load();

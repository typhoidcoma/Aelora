import { readFileSync, existsSync } from "node:fs";
import * as vectorStore from "./vector-store.js";
import { formatError } from "./vector-store.js";
import type { VectorStoreConfig } from "./vector-store.js";
import { queueTextWrite } from "./async-write-queue.js";

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

export type FactCategory = "preference" | "biographical" | "behavioral" | "relationship" | "technical" | "contextual";
export type FactConfidence = "stated" | "inferred";

export type MemoryFact = {
  fact: string;
  savedAt: string;
  category: FactCategory;
  confidence: FactConfidence;
  source: string;            // "channel:123", "manual", "legacy", "consolidation"
  lastAccessedAt?: string;
  accessCount?: number;
};

export type FactMetadataInput = {
  category?: FactCategory;
  confidence?: FactConfidence;
  source?: string;
};

type MemoryStore = Record<string, MemoryFact[]>;

let store: MemoryStore = {};

function load(): void {
  try {
    if (existsSync(MEMORY_FILE)) {
      const raw = JSON.parse(readFileSync(MEMORY_FILE, "utf-8"));
      let migrated = false;
      for (const [scope, facts] of Object.entries(raw)) {
        if (!Array.isArray(facts)) continue;
        raw[scope] = (facts as any[]).map((f) => {
          if (f.category) return f; // already migrated
          migrated = true;
          return {
            fact: f.fact,
            savedAt: f.savedAt,
            category: "contextual" as FactCategory,
            confidence: "inferred" as FactConfidence,
            source: "legacy",
            accessCount: 0,
          };
        });
      }
      store = raw;
      if (migrated) {
        save();
        console.log("Memory: migrated legacy facts to enriched format");
      }
    }
  } catch {
    store = {};
  }
}

function save(): void {
  try {
    queueTextWrite(MEMORY_FILE, JSON.stringify(store, null, 2), { debounceMs: 200, atomic: true });
  } catch (err) {
    console.error("Memory: failed to save:", err);
  }
}

export function saveFact(
  scope: string,
  fact: string,
  metadata?: FactMetadataInput,
): { success: boolean; error?: string } {
  const trimmed = fact.trim().slice(0, maxFactLength);
  if (!trimmed) return { success: false, error: "Fact cannot be empty" };

  if (!store[scope]) store[scope] = [];

  // Check for duplicates
  if (store[scope].some((f) => f.fact === trimmed)) {
    return { success: false, error: "Duplicate fact  -  already remembered" };
  }

  const savedAt = new Date().toISOString();
  const entry: MemoryFact = {
    fact: trimmed,
    savedAt,
    category: metadata?.category ?? "contextual",
    confidence: metadata?.confidence ?? "inferred",
    source: metadata?.source ?? "auto",
    accessCount: 0,
  };
  store[scope].push(entry);

  // Cap at max
  if (store[scope].length > maxFactsPerScope) {
    store[scope] = store[scope].slice(-maxFactsPerScope);
  }

  save();
  console.log(`Memory: saved fact to "${scope}" [${entry.category}/${entry.confidence}] (${store[scope].length} total)`);

  // Fire-and-forget vector indexing
  if (vectorEnabled) {
    vectorStore.indexFact(scope, trimmed, savedAt, {
      category: entry.category,
      confidence: entry.confidence,
      source: entry.source,
    }).catch((err) => {
      console.warn("Memory: vector indexing failed:", formatError(err));
    });
  }

  // Track for consolidation
  if (_onFactAdded) _onFactAdded(scope);

  return { success: true };
}

// Consolidation callback — set by heartbeat-consolidation.ts
let _onFactAdded: ((scope: string) => void) | null = null;
export function setOnFactAdded(cb: (scope: string) => void): void {
  _onFactAdded = cb;
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
      console.warn("Memory: vector removal failed:", formatError(err));
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
      console.warn("Memory: vector scope removal failed:", formatError(err));
    });
  }

  return count;
}

export function getAllMemory(): MemoryStore {
  return { ...store };
}

// ── Access tracking (debounced save) ──────────────────────

let _pendingAccessUpdates = false;
let _accessFlushTimer: ReturnType<typeof setTimeout> | null = null;

function trackAccess(scope: string, factText: string): void {
  const facts = store[scope];
  if (!facts) return;
  const f = facts.find((f) => f.fact === factText);
  if (!f) return;
  f.lastAccessedAt = new Date().toISOString();
  f.accessCount = (f.accessCount ?? 0) + 1;
  _pendingAccessUpdates = true;
}

function flushAccessUpdates(): void {
  if (!_pendingAccessUpdates) return;
  _pendingAccessUpdates = false;
  save();
}

// Flush every 10 seconds if updates are pending
function ensureAccessFlushTimer(): void {
  if (_accessFlushTimer) return;
  _accessFlushTimer = setInterval(() => {
    flushAccessUpdates();
  }, 10_000);
}

// ── Ranking ───────────────────────────────────────────────

function rankFact(semanticScore: number, fact: MemoryFact): number {
  const now = Date.now();
  // Recency: exponential decay over 30 days, floor at 0.3
  const ageDays = (now - new Date(fact.savedAt).getTime()) / 86_400_000;
  const recency = Math.max(0.3, Math.exp(-0.03 * ageDays));
  // Access frequency: log boost, capped at 0.2
  const accessBoost = Math.min(0.2, 0.05 * Math.log2(1 + (fact.accessCount ?? 0)));
  // Blend: semantic 70%, recency 20%, access 10%
  return semanticScore * 0.70 + recency * 0.20 + accessBoost * 0.10;
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
        const factObj: MemoryFact = idx >= 0 ? scopeFacts[idx] : {
          fact: r.fact, savedAt: r.savedAt,
          category: "contextual", confidence: "inferred", source: "unknown",
        };
        return {
          scope: r.scope,
          index: idx >= 0 ? idx : 0,
          fact: factObj,
          score: r.score,
        };
      });
    } catch (err) {
      console.warn("Memory: semantic search failed, falling back to keyword:", formatError(err));
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
        // Apply weighted ranking
        const ranked = results.map((r) => {
          const scopeFacts = store[r.scope] ?? [];
          const factObj = scopeFacts.find((f) => f.fact === r.fact);
          const rank = factObj ? rankFact(r.score, factObj) : r.score;
          return { ...r, rank };
        }).sort((a, b) => b.rank - a.rank);

        // Group by scope type
        const global: string[] = [];
        const user: string[] = [];
        const channel: string[] = [];

        for (const r of ranked) {
          if (r.scope === "global" && global.length < MAX_GLOBAL_INJECTED) {
            global.push(r.fact);
          } else if (r.scope.startsWith("user:") && user.length < MAX_SCOPED_INJECTED) {
            user.push(r.fact);
          } else if (r.scope.startsWith("channel:") && channel.length < MAX_SCOPED_INJECTED) {
            channel.push(r.fact);
          }
        }

        // Track access for injected facts
        ensureAccessFlushTimer();
        for (const r of ranked) {
          const selected = [...global, ...user, ...channel];
          if (selected.includes(r.fact)) {
            trackAccess(r.scope, r.fact);
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
      console.warn("Memory: semantic prompt injection failed, falling back to recency:", formatError(err));
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
          console.warn("Memory: vector prune removal failed:", formatError(err));
        });
      }
    }
  }

  return pruned;
}

// Load from disk on module init
load();

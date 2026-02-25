import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const MEMORY_FILE = "data/memory.json";

// Defaults — overridden by configureMemory() after config loads
let maxFactsPerScope = 100;
let maxFactLength = 1000;

/** Apply config overrides. Call after config is loaded. */
export function configureMemory(opts: { maxFactsPerScope?: number; maxFactLength?: number }): void {
  if (opts.maxFactsPerScope) maxFactsPerScope = opts.maxFactsPerScope;
  if (opts.maxFactLength) maxFactLength = opts.maxFactLength;
}

// Prompt injection caps — keep system prompt bounded
const MAX_GLOBAL_INJECTED = 10;
const MAX_SCOPED_INJECTED = 15;

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
    return { success: false, error: "Duplicate fact — already remembered" };
  }

  store[scope].push({ fact: trimmed, savedAt: new Date().toISOString() });

  // Cap at max
  if (store[scope].length > maxFactsPerScope) {
    store[scope] = store[scope].slice(-maxFactsPerScope);
  }

  save();
  console.log(`Memory: saved fact to "${scope}" (${store[scope].length} total)`);
  return { success: true };
}

export function getFacts(scope: string): MemoryFact[] {
  return store[scope] ?? [];
}

export function deleteFact(scope: string, index: number): boolean {
  const facts = store[scope];
  if (!facts || index < 0 || index >= facts.length) return false;

  facts.splice(index, 1);
  if (facts.length === 0) delete store[scope];
  save();
  console.log(`Memory: deleted fact from "${scope}" (index ${index})`);
  return true;
}

export function clearScope(scope: string): number {
  const facts = store[scope];
  if (!facts) return 0;
  const count = facts.length;
  delete store[scope];
  save();
  console.log(`Memory: cleared scope "${scope}" (${count} facts removed)`);
  return count;
}

export function getAllMemory(): MemoryStore {
  return { ...store };
}

/**
 * Search facts across all scopes by keyword.
 * Returns matching facts with their scope and index.
 */
export function searchFacts(
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
 * Caps each section to avoid prompt bloat; hints that more is available via search.
 */
export function getMemoryForPrompt(userId: string | null, channelId: string | null): string {
  const sections: string[] = [];

  // Global knowledge (always included)
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

  for (const [scope, facts] of Object.entries(store)) {
    const before = facts.length;
    store[scope] = facts.filter((f) => new Date(f.savedAt).getTime() >= cutoff);
    pruned += before - store[scope].length;

    if (store[scope].length === 0) delete store[scope];
  }

  if (pruned > 0) {
    save();
    console.log(`Memory: pruned ${pruned} fact(s) older than ${maxAgeDays} days`);
  }

  return pruned;
}

// Load from disk on module init
load();

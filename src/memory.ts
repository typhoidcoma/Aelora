import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const MEMORY_FILE = "data/memory.json";
const MAX_FACTS_PER_SCOPE = 20;
const MAX_FACT_LENGTH = 300;

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
  const trimmed = fact.trim().slice(0, MAX_FACT_LENGTH);
  if (!trimmed) return { success: false, error: "Fact cannot be empty" };

  if (!store[scope]) store[scope] = [];

  // Check for duplicates
  if (store[scope].some((f) => f.fact === trimmed)) {
    return { success: false, error: "Duplicate fact — already remembered" };
  }

  store[scope].push({ fact: trimmed, savedAt: new Date().toISOString() });

  // Cap at max
  if (store[scope].length > MAX_FACTS_PER_SCOPE) {
    store[scope] = store[scope].slice(-MAX_FACTS_PER_SCOPE);
  }

  save();
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
  return true;
}

export function clearScope(scope: string): number {
  const facts = store[scope];
  if (!facts) return 0;
  const count = facts.length;
  delete store[scope];
  save();
  return count;
}

export function getAllMemory(): MemoryStore {
  return { ...store };
}

/**
 * Build a formatted memory block for system prompt injection.
 * Returns empty string if no relevant facts exist.
 */
export function getMemoryForPrompt(userId: string | null, channelId: string | null): string {
  const sections: string[] = [];

  if (userId) {
    const userFacts = store[`user:${userId}`];
    if (userFacts && userFacts.length > 0) {
      sections.push("### About this user");
      for (const f of userFacts) sections.push(`- ${f.fact}`);
    }
  }

  if (channelId) {
    const channelFacts = store[`channel:${channelId}`];
    if (channelFacts && channelFacts.length > 0) {
      sections.push("### About this channel");
      for (const f of channelFacts) sections.push(`- ${f.fact}`);
    }
  }

  if (sections.length === 0) return "";
  return "\n\n## Memory\n" + sections.join("\n");
}

// Load from disk on module init
load();

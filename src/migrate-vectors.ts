/**
 * One-time migration script: reads all facts from data/memory.json,
 * embeds them, and upserts into the Vectra vector index.
 *
 * Usage: npx tsx src/migrate-vectors.ts
 *
 * Also called automatically by memory.ts on first boot when the
 * vector index doesn't exist yet.
 */

import { readFileSync, existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { initVectorStore, rebuildIndex } from "./vector-store.js";

const MEMORY_FILE = "data/memory.json";

async function main() {
  console.log("Vector migration: starting...");

  // Load config
  const config = loadConfig();

  // Resolve embedding API key: dedicated key > LLM key
  const apiKey = config.memory.embeddingApiKey || config.llm.apiKey;
  if (!apiKey) {
    console.error("Vector migration: no embedding API key available. Set memory.embeddingApiKey or llm.apiKey.");
    process.exit(1);
  }

  // Init vector store
  const ok = await initVectorStore({
    enabled: true,
    apiKey,
    baseURL: config.memory.embeddingBaseURL,
    model: config.memory.embeddingModel,
    dimensions: config.memory.embeddingDimensions,
    dedupThreshold: config.memory.semanticDedupThreshold,
    searchTopK: config.memory.semanticSearchTopK,
    searchMinScore: config.memory.semanticSearchMinScore,
  });

  if (!ok) {
    console.error("Vector migration: failed to initialize vector store.");
    process.exit(1);
  }

  // Load facts
  if (!existsSync(MEMORY_FILE)) {
    console.log("Vector migration: no memory.json found — nothing to migrate.");
    return;
  }

  let store: Record<string, { fact: string; savedAt: string }[]>;
  try {
    store = JSON.parse(readFileSync(MEMORY_FILE, "utf-8"));
  } catch (err) {
    console.error("Vector migration: failed to parse memory.json:", err);
    process.exit(1);
  }

  const totalFacts = Object.values(store).reduce((sum, facts) => sum + facts.length, 0);
  console.log(`Vector migration: found ${totalFacts} facts across ${Object.keys(store).length} scopes`);

  const result = await rebuildIndex(store);
  console.log(`Vector migration: done — ${result.indexed} indexed, ${result.errors} errors`);
}

main().catch((err) => {
  console.error("Vector migration: fatal error:", err);
  process.exit(1);
});

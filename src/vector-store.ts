import { LocalIndex, OpenAIEmbeddings } from "vectra";
import type { OpenAIEmbeddingsOptions } from "vectra";
import type { MetadataTypes } from "vectra";
import path from "node:path";

// ── Types ────────────────────────────────────────────────

type FactMetadata = {
  scope: string;
  fact: string;
  savedAt: string;
  category?: string;
  confidence?: string;
  source?: string;
};

export interface SemanticSearchResult {
  scope: string;
  fact: string;
  savedAt: string;
  score: number;
}

export interface VectorStoreConfig {
  enabled: boolean;
  apiKey: string;
  baseURL: string;
  model: string;
  dimensions: number;
  dedupThreshold: number;
  searchTopK: number;
  searchMinScore: number;
}

// ── State ────────────────────────────────────────────────

const INDEX_PATH = path.join("data", "vectors", "memory");

let index: LocalIndex<Record<string, MetadataTypes>> | null = null;
let embeddings: OpenAIEmbeddings | null = null;
let config: VectorStoreConfig | null = null;

// Simple LRU cache for recent embeddings to avoid redundant API calls
const embeddingCache = new Map<string, number[]>();
const CACHE_MAX = 100;

// ── Initialisation ───────────────────────────────────────

export async function initVectorStore(cfg: VectorStoreConfig): Promise<boolean> {
  if (!cfg.enabled || !cfg.apiKey) {
    console.log("VectorStore: disabled (vectorSearch=false or no embedding API key)");
    return false;
  }

  config = cfg;

  // Strip /v1 suffix if present — OpenAIEmbeddings adds /v1/embeddings itself
  const endpoint = cfg.baseURL.replace(/\/v1\/?$/, "").replace(/\/+$/, "");

  embeddings = new OpenAIEmbeddings({
    apiKey: cfg.apiKey,
    model: cfg.model,
    dimensions: cfg.dimensions,
    endpoint,
  } as OpenAIEmbeddingsOptions);

  index = new LocalIndex(INDEX_PATH);

  if (!(await index.isIndexCreated())) {
    await index.createIndex({ version: 1 });
    console.log("VectorStore: created new index at", INDEX_PATH);
  } else {
    const stats = await index.getIndexStats();
    console.log(`VectorStore: loaded existing index from ${INDEX_PATH} (${stats.items} vectors)`);
  }

  // Validate embedding endpoint with a test call
  try {
    const testRes = await embeddings.createEmbeddings("test");
    if (testRes.status !== "success") {
      console.error(`VectorStore: ❌ Embedding API rejected request — status="${testRes.status}", message="${testRes.message ?? "unknown"}". Vector search will be DISABLED.`);
      embeddings = null;
      index = null;
      return false;
    }
    console.log(`VectorStore: ✅ Embedding API validated (model=${cfg.model}, dims=${cfg.dimensions})`);
  } catch (err) {
    console.error(`VectorStore: ❌ Embedding API unreachable — ${err instanceof Error ? err.message : err}. Vector search will be DISABLED.`);
    embeddings = null;
    index = null;
    return false;
  }

  return true;
}

export function isReady(): boolean {
  return index !== null && embeddings !== null;
}

// ── Embedding helper ─────────────────────────────────────

async function embed(text: string): Promise<number[] | null> {
  if (!embeddings) return null;

  // Check cache
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const res = await embeddings.createEmbeddings(text);
  if (res.status !== "success" || !res.output || res.output.length === 0) {
    console.warn("VectorStore: embedding failed:", res.status, res.message);
    return null;
  }

  const vec = res.output[0];

  // Cache with eviction
  if (embeddingCache.size >= CACHE_MAX) {
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey !== undefined) embeddingCache.delete(firstKey);
  }
  embeddingCache.set(text, vec);

  return vec;
}

async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (!embeddings) return texts.map(() => null);

  // OpenAI supports batch embedding — send all at once
  const res = await embeddings.createEmbeddings(texts);
  if (res.status !== "success" || !res.output) {
    console.warn("VectorStore: batch embedding failed:", res.status, res.message);
    return texts.map(() => null);
  }

  // Cache results
  for (let i = 0; i < texts.length; i++) {
    if (res.output[i]) {
      if (embeddingCache.size >= CACHE_MAX) {
        const firstKey = embeddingCache.keys().next().value;
        if (firstKey !== undefined) embeddingCache.delete(firstKey);
      }
      embeddingCache.set(texts[i], res.output[i]);
    }
  }

  return res.output;
}

// ── Stable ID from scope + fact text ─────────────────────

function factId(scope: string, fact: string): string {
  // Simple hash to create a stable ID
  let hash = 0;
  const str = `${scope}::${fact}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return `fact_${(hash >>> 0).toString(36)}`;
}

// ── Public API ───────────────────────────────────────────

export async function indexFact(
  scope: string,
  fact: string,
  savedAt: string,
  extra?: { category?: string; confidence?: string; source?: string },
): Promise<void> {
  if (!index || !embeddings) return;

  const vec = await embed(fact);
  if (!vec) return;

  const id = factId(scope, fact);
  const metadata: FactMetadata = { scope, fact, savedAt, ...extra };
  await index.upsertItem({
    id,
    vector: vec,
    metadata: metadata as unknown as Record<string, MetadataTypes>,
  });
}

export async function removeFact(scope: string, fact: string): Promise<void> {
  if (!index) return;

  const id = factId(scope, fact);
  try {
    await index.deleteItem(id);
  } catch {
    // Item may not exist — that's fine
  }
}

export async function removeScope(scope: string): Promise<void> {
  if (!index) return;

  const items = await index.listItemsByMetadata({ scope: { $eq: scope } });
  if (items.length === 0) return;

  await index.beginUpdate();
  for (const item of items) {
    await index.deleteItem(item.id);
  }
  await index.endUpdate();
}

export async function semanticSearch(
  query: string,
  opts?: { scopes?: string[]; topK?: number; minScore?: number },
): Promise<SemanticSearchResult[]> {
  if (!index || !embeddings || !config) return [];

  const vec = await embed(query);
  if (!vec) return [];

  const topK = opts?.topK ?? config.searchTopK;
  const minScore = opts?.minScore ?? config.searchMinScore;

  // Apply scope filter if provided
  let filter: Record<string, unknown> | undefined;
  if (opts?.scopes && opts.scopes.length > 0) {
    if (opts.scopes.length === 1) {
      filter = { scope: { $eq: opts.scopes[0] } };
    } else {
      filter = { $or: opts.scopes.map((s) => ({ scope: { $eq: s } })) };
    }
  }

  const results = await index.queryItems(vec, query, topK, filter as any);

  return results
    .filter((r) => r.score >= minScore)
    .map((r) => ({
      scope: r.item.metadata.scope as string,
      fact: r.item.metadata.fact as string,
      savedAt: r.item.metadata.savedAt as string,
      score: r.score,
    }));
}

export async function isDuplicateSemantic(
  fact: string,
  scope: string,
  threshold?: number,
): Promise<boolean> {
  if (!index || !embeddings || !config) return false;

  const th = threshold ?? config.dedupThreshold;
  const results = await semanticSearch(fact, {
    scopes: [scope],
    topK: 1,
    minScore: th,
  });

  return results.length > 0;
}

/**
 * Rebuild the entire vector index from the JSON fact store.
 * Pass the full memory store as a record of scope → facts.
 */
export async function rebuildIndex(
  store: Record<string, { fact: string; savedAt: string }[]>,
): Promise<{ indexed: number; errors: number }> {
  if (!index || !embeddings) {
    return { indexed: 0, errors: 0 };
  }

  // Delete and recreate the index
  await index.deleteIndex();
  await index.createIndex({ version: 1 });
  embeddingCache.clear();

  let indexed = 0;
  let errors = 0;

  // Collect all facts for batch embedding
  const allFacts: { scope: string; fact: string; savedAt: string }[] = [];
  for (const [scope, facts] of Object.entries(store)) {
    for (const f of facts) {
      allFacts.push({ scope, fact: f.fact, savedAt: f.savedAt });
    }
  }

  if (allFacts.length === 0) return { indexed: 0, errors: 0 };

  // Batch embed in chunks of 100
  const BATCH_SIZE = 100;
  for (let i = 0; i < allFacts.length; i += BATCH_SIZE) {
    const batch = allFacts.slice(i, i + BATCH_SIZE);
    const texts = batch.map((f) => f.fact);
    const vectors = await embedBatch(texts);

    await index.beginUpdate();
    for (let j = 0; j < batch.length; j++) {
      const vec = vectors[j];
      if (!vec) {
        errors++;
        continue;
      }

      const f = batch[j];
      const id = factId(f.scope, f.fact);
      await index.upsertItem({
        id,
        vector: vec,
        metadata: { scope: f.scope, fact: f.fact, savedAt: f.savedAt } as unknown as Record<string, MetadataTypes>,
      });
      indexed++;
    }
    await index.endUpdate();

    console.log(`VectorStore: rebuild progress ${Math.min(i + BATCH_SIZE, allFacts.length)}/${allFacts.length}`);
  }

  console.log(`VectorStore: rebuild complete — ${indexed} indexed, ${errors} errors`);
  return { indexed, errors };
}

export async function getIndexStats(): Promise<{ items: number } | null> {
  if (!index) return null;
  try {
    const stats = await index.getIndexStats();
    return { items: stats.items };
  } catch {
    return null;
  }
}

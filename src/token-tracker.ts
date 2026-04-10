/**
 * Centralized token usage tracker.
 *
 * Records prompt/completion token counts from every LLM call,
 * persists rolling stats to disk, and exposes an API for the dashboard.
 */

import { readFileSync, existsSync } from "node:fs";
import { queueTextWrite } from "./async-write-queue.js";
import { broadcastEvent } from "./logger.js";

const STATS_FILE = "data/token-usage.json";

// ── Types ───────────────────────────────────────────────

export type TokenUsageEvent = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  model: string;
  source: string;  // e.g. "chat", "extraction", "triage", "mood", "consolidation", "ambient", "compaction", "scoring", "correction"
};

type HourlyBucket = {
  hour: string;           // ISO hour "2026-04-10T15"
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requests: number;
};

type ModelStats = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requests: number;
};

type SourceStats = ModelStats;

type TokenStats = {
  lifetime: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    requests: number;
    firstTrackedAt: string;
  };
  today: {
    date: string;         // "2026-04-10"
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    requests: number;
  };
  hourly: HourlyBucket[]; // rolling 48 hours
  byModel: Record<string, ModelStats>;
  bySource: Record<string, SourceStats>;
};

// ── State ───────────────────────────────────────────────

let stats: TokenStats = createEmptyStats();
let dirty = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function createEmptyStats(): TokenStats {
  return {
    lifetime: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requests: 0,
      firstTrackedAt: new Date().toISOString(),
    },
    today: {
      date: todayStr(),
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requests: 0,
    },
    hourly: [],
    byModel: {},
    bySource: {},
  };
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function currentHour(): string {
  return new Date().toISOString().slice(0, 13); // "2026-04-10T15"
}

// ── Persistence ─────────────────────────────────────────

function load(): void {
  try {
    if (existsSync(STATS_FILE)) {
      const raw = JSON.parse(readFileSync(STATS_FILE, "utf-8"));
      stats = {
        lifetime: raw.lifetime ?? createEmptyStats().lifetime,
        today: raw.today ?? createEmptyStats().today,
        hourly: Array.isArray(raw.hourly) ? raw.hourly : [],
        byModel: raw.byModel ?? {},
        bySource: raw.bySource ?? {},
      };
    }
  } catch {
    stats = createEmptyStats();
  }
}

function save(): void {
  if (!dirty) return;
  dirty = false;
  queueTextWrite(STATS_FILE, JSON.stringify(stats, null, 2), { debounceMs: 2000, atomic: true });
}

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(save, 5_000);
}

// ── Day rollover ────────────────────────────────────────

function rolloverDay(): void {
  const today = todayStr();
  if (stats.today.date !== today) {
    stats.today = {
      date: today,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requests: 0,
    };
  }
}

// ── Hourly bucket management ────────────────────────────

function getOrCreateHourBucket(): HourlyBucket {
  const hour = currentHour();
  let bucket = stats.hourly.find((b) => b.hour === hour);
  if (!bucket) {
    bucket = { hour, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 };
    stats.hourly.push(bucket);

    // Prune buckets older than 48 hours
    const cutoff = new Date(Date.now() - 48 * 3_600_000).toISOString().slice(0, 13);
    stats.hourly = stats.hourly.filter((b) => b.hour >= cutoff);
  }
  return bucket;
}

// ── Public API ──────────────────────────────────────────

/**
 * Record token usage from an LLM call. Call this after every API response.
 * Accepts partial data — missing fields default to 0.
 */
export function recordUsage(event: TokenUsageEvent): void {
  const input = event.inputTokens || 0;
  const output = event.outputTokens || 0;
  const reasoning = event.reasoningTokens || 0;

  if (input === 0 && output === 0) return; // nothing to record

  rolloverDay();

  // Lifetime
  stats.lifetime.inputTokens += input;
  stats.lifetime.outputTokens += output;
  stats.lifetime.reasoningTokens += reasoning;
  stats.lifetime.requests++;

  // Today
  stats.today.inputTokens += input;
  stats.today.outputTokens += output;
  stats.today.reasoningTokens += reasoning;
  stats.today.requests++;

  // Hourly
  const bucket = getOrCreateHourBucket();
  bucket.inputTokens += input;
  bucket.outputTokens += output;
  bucket.reasoningTokens += reasoning;
  bucket.requests++;

  // By model
  const modelKey = event.model || "unknown";
  if (!stats.byModel[modelKey]) {
    stats.byModel[modelKey] = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 };
  }
  stats.byModel[modelKey].inputTokens += input;
  stats.byModel[modelKey].outputTokens += output;
  stats.byModel[modelKey].reasoningTokens += reasoning;
  stats.byModel[modelKey].requests++;

  // By source
  const sourceKey = event.source || "unknown";
  if (!stats.bySource[sourceKey]) {
    stats.bySource[sourceKey] = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 };
  }
  stats.bySource[sourceKey].inputTokens += input;
  stats.bySource[sourceKey].outputTokens += output;
  stats.bySource[sourceKey].reasoningTokens += reasoning;
  stats.bySource[sourceKey].requests++;

  dirty = true;
  ensureFlushTimer();

  // Broadcast for real-time dashboard
  broadcastEvent("tokens", {
    type: "tokens:usage",
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    model: modelKey,
    source: sourceKey,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Helper: extract usage from an OpenAI chat completion response and record it.
 * Works with any response that has a `.usage` field (streaming or non-streaming).
 */
export function recordCompletionUsage(
  response: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null },
  model: string,
  source: string,
): void {
  const usage = response?.usage;
  if (!usage) return;
  recordUsage({
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    model,
    source,
  });
}

/** Get current stats snapshot for the dashboard API. */
export function getTokenStats(): TokenStats {
  rolloverDay();
  return { ...stats };
}

/** Reset all stats (for testing or manual reset). */
export function resetTokenStats(): void {
  stats = createEmptyStats();
  dirty = true;
  save();
}

// Load from disk on module init
load();

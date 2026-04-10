/**
 * Pre-response message triage — lightweight async LLM call that runs on
 * incoming user text BEFORE the bot starts responding.
 *
 * Extracts temporal references, named entities, sentiment signals, and
 * action-item markers. Results are cached per-channel and consumed by
 * the post-response fact extractor for richer extraction.
 *
 * Fire-and-forget — never blocks the bot's response.
 */

import type OpenAI from "openai";
import { getLLMClient, getAuxiliaryModel, getDisableThinking, stripThinkBlocks } from "./llm.js";
import { broadcastEvent } from "./logger.js";
import { recordCompletionUsage } from "./token-tracker.js";

// ── Types ───────────────────────────────────────────────

export type TriageResult = {
  resolvedDates: Record<string, string>;  // "tomorrow" → "2026-04-11"
  namedEntities: string[];                 // people/places mentioned
  sentiment: string | null;                // "frustrated about X", "excited about Y"
  hasActionItems: boolean;
  urgencySignals: string[];                // "deadline", "asap", "need to"
  timestamp: number;
};

// ── State ───────────────────────────────────────────────

const triageCache = new Map<string, TriageResult>();
const lastTriage = new Map<string, number>();
let cooldownMs = 30_000; // default 30s, overridden by config

export function configureTriageCooldown(ms: number): void {
  cooldownMs = ms;
}

/** Get cached triage result for a channel (consumed by fact-extractor). */
export function getTriageResult(channelId: string): TriageResult | undefined {
  return triageCache.get(channelId);
}

/** Clear triage result after consumption. */
export function consumeTriageResult(channelId: string): TriageResult | undefined {
  const result = triageCache.get(channelId);
  triageCache.delete(channelId);
  return result;
}

// ── Triage prompt ───────────────────────────────────────

function buildTriagePrompt(): string {
  const today = new Date().toISOString().split("T")[0];
  return (
    "You are a JSON-only message triage system. Output ONLY a single JSON object. No text before or after.\n\n" +
    `Today's date is ${today}.\n\n` +
    "Analyze the user's message and extract:\n" +
    '1. "resolvedDates": Map any relative date references to absolute ISO dates. ' +
    `E.g. "tomorrow" → "${nextDay(today)}", "next Friday" → the upcoming Friday's date. Empty object if no dates.\n` +
    '2. "namedEntities": List of people, places, or organizations mentioned by name. Empty array if none.\n' +
    '3. "sentiment": If the user expresses a clear emotion about a specific topic, describe it briefly ' +
    '(e.g. "frustrated about webpack config", "excited about new project"). null if no clear sentiment.\n' +
    '4. "hasActionItems": true if the user mentions something they need to do, a task, deadline, or obligation.\n' +
    '5. "urgencySignals": List of urgency keywords found (e.g. "deadline", "asap", "need to", "have to", "urgent"). Empty array if none.\n\n' +
    "Rules:\n" +
    "- Be concise. This is a fast triage, not deep analysis.\n" +
    "- Only extract what is clearly present. Do not infer or speculate.\n" +
    "- For dates, resolve relative to today's date.\n\n" +
    'Response format:\n' +
    '{"resolvedDates":{"tomorrow":"' + nextDay(today) + '"},"namedEntities":["Alice"],"sentiment":"excited about new project","hasActionItems":true,"urgencySignals":["need to"]}'
  );
}

function nextDay(isoDate: string): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

// ── Public API ──────────────────────────────────────────

/**
 * Triage a user message asynchronously. Fire-and-forget.
 * Results are cached per-channel for the fact extractor to consume.
 */
export async function triageUserMessage(
  text: string,
  channelId: string,
): Promise<void> {
  // Skip very short messages
  if (text.length < 15) return;

  // Cooldown per channel
  const now = Date.now();
  const last = lastTriage.get(channelId) ?? 0;
  if (now - last < cooldownMs) return;
  lastTriage.set(channelId, now);

  const client = getLLMClient();
  const model = getAuxiliaryModel();

  try {
    const triageParams: Record<string, unknown> = {
      model,
      max_completion_tokens: 512,
      ...(getDisableThinking() ? { enable_thinking: false } : {}),
      messages: [
        { role: "system", content: buildTriagePrompt() },
        { role: "user", content: getDisableThinking() ? `/no_think\n${text.slice(0, 500)}` : text.slice(0, 500) },
      ],
    };

    const result = await client.chat.completions.create(
      triageParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    );
    recordCompletionUsage(result, model, "triage");

    let rawContent = stripThinkBlocks(result.choices[0]?.message?.content?.trim() ?? "");
    if (!rawContent) return;

    // Strip markdown fences
    rawContent = rawContent.replace(/^```(?:json)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();

    const parsed = JSON.parse(rawContent);

    const triageResult: TriageResult = {
      resolvedDates: parsed.resolvedDates && typeof parsed.resolvedDates === "object" ? parsed.resolvedDates : {},
      namedEntities: Array.isArray(parsed.namedEntities) ? parsed.namedEntities.filter((e: unknown) => typeof e === "string") : [],
      sentiment: typeof parsed.sentiment === "string" ? parsed.sentiment : null,
      hasActionItems: parsed.hasActionItems === true,
      urgencySignals: Array.isArray(parsed.urgencySignals) ? parsed.urgencySignals.filter((e: unknown) => typeof e === "string") : [],
      timestamp: Date.now(),
    };

    triageCache.set(channelId, triageResult);

    broadcastEvent("mindmap", {
      type: "triage:completed",
      conversationId: channelId,
      hasActionItems: triageResult.hasActionItems,
      sentiment: triageResult.sentiment,
      entityCount: triageResult.namedEntities.length,
      dateCount: Object.keys(triageResult.resolvedDates).length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Triage is best-effort — failures are silent
    console.warn("MessageTriage: triage failed:", err instanceof Error ? err.message : err);
  }
}

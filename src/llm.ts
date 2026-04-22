import OpenAI from "openai";
import { readFileSync, existsSync } from "node:fs";
import type { Config } from "./config.js";
import {
  getToolDefinitionsForOpenAI,
  getEnabledTools,
  executeToolText,
} from "./tool-registry.js";
import { getMemoryForPrompt } from "./memory.js";
import { searchKnowledgeBase } from "./knowledge-base.js";
import { buildMoodPromptSection, loadMood } from "./mood.js";
import { StreamEmotionAnalyzer, moodStateToVector, analyzeUserText } from "./emotion-vector.js";
import { getUser } from "./users.js";
import { getSession } from "./sessions.js";
import { detectPhantomClaims, type ToolRecord } from "./tool-claim-detector.js";
import { queueTextWrite } from "./async-write-queue.js";
import { broadcastEvent } from "./logger.js";
import { selectProviderRuntime } from "./llm/runtime-selector.js";
import { recordUsage, recordCompletionUsage } from "./token-tracker.js";
import { getProfileForPrompt } from "./user-profile.js";
import { createLLMTransport } from "./llm/http-client.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type UserContent = string | ContentPart[];

/** Called for each text token during streaming. */
export type OnTokenCallback = (token: string) => void;

/** Truncate text for mindmap event previews. */
function truncatePreview(text: string | ContentPart[], maxLen = 80): string {
  const str = typeof text === "string" ? text : text.map((p) => ("text" in p ? p.text : "[media]")).join(" ");
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

/** Called when the LLM is about to execute tool(s). Names of tools being called are passed. */
export type OnToolCallCallback = (toolNames: string[]) => void;

export type ToolLoopRenderResult = {
  assistantContent: string;
  userContent: string;
};

// --- Error detection ---

function isToolTemplateError(err: unknown): boolean {
  const msg = errorMessage(err);
  return /jinja template|no user query found/i.test(msg);
}

function isContextSizeError(err: unknown): boolean {
  const msg = errorMessage(err);
  return /context (size|length|window).*exceeded|maximum context|token limit|too many tokens|model's maximum|context_length_exceeded/i.test(msg);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message
    : typeof err === "object" && err !== null ? JSON.stringify(err)
    : String(err);
}


// --- Think-block stripping (for reasoning models like Qwen, DeepSeek) ---

/** Strip reasoning/thinking content from LLM output (handles multiple model formats). */
export function stripThinkBlocks(text: string): string {
  // Safety net: strip <think>/<reasoning> tags if they leak through.
  // Normally LM Studio handles this via the Jinja template and its thinking toggle.
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .replace(/<think>[\s\S]*$/g, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>\s*/g, "")
    .replace(/<reasoning>[\s\S]*$/g, "")
    .replace(/^\s*<\/think>\s*/g, "")
    .replace(/^\s*<\/reasoning>\s*/g, "")
    .trim();
}

/** Streaming filter that suppresses thinking/reasoning blocks from reaching the token callback. */
class ThinkBlockFilter {
  private buffer = "";
  private inThink = false;
  private closeTag = "</think>";
  private onToken: OnTokenCallback;
  constructor(onToken: OnTokenCallback) { this.onToken = onToken; }

  push(token: string): void {
    this.buffer += token;
    this.drain();
  }

  flush(): void {
    if (!this.inThink && this.buffer) this.onToken(this.buffer);
    this.buffer = "";
  }

  private drain(): void {
    while (this.buffer) {
      if (this.inThink) {
        const end = this.buffer.indexOf(this.closeTag);
        if (end === -1) return; // still waiting for close tag
        this.inThink = false;
        let after = end + this.closeTag.length;
        while (after < this.buffer.length && "\n\r ".includes(this.buffer[after])) after++;
        this.buffer = this.buffer.slice(after);
      } else {
        // Strip orphaned closing tags (model splits thinking across content boundaries)
        const orphanClose = this.buffer.match(/^\s*<\/(think|reasoning)>\s*/);
        if (orphanClose) {
          this.buffer = this.buffer.slice(orphanClose[0].length);
          continue;
        }

        // Check for <think> or <reasoning> open tags
        const thinkStart = this.buffer.indexOf("<think>");
        const reasonStart = this.buffer.indexOf("<reasoning>");
        let start = -1;
        if (thinkStart !== -1 && (reasonStart === -1 || thinkStart < reasonStart)) {
          start = thinkStart; this.closeTag = "</think>";
        } else if (reasonStart !== -1) {
          start = reasonStart; this.closeTag = "</reasoning>";
        }

        if (start === -1) {
          const partial = this.partialTagLen();
          if (partial > 0) {
            const safe = this.buffer.length - partial;
            if (safe > 0) { this.onToken(this.buffer.slice(0, safe)); this.buffer = this.buffer.slice(safe); }
            return;
          }
          this.onToken(this.buffer);
          this.buffer = "";
          return;
        }
        if (start > 0) this.onToken(this.buffer.slice(0, start));
        this.inThink = true;
        const openLen = this.closeTag === "</think>" ? 7 : 11; // "<think>".length or "<reasoning>".length
        this.buffer = this.buffer.slice(start + openLen);
      }
    }
  }

  private partialTagLen(): number {
    for (const tag of ["<think>", "<reasoning>"]) {
      for (let len = tag.length - 1; len > 0; len--) {
        if (this.buffer.endsWith(tag.slice(0, len))) return len;
      }
    }
    return 0;
  }
}

// --- System state provider (avoids circular deps with discord/cron/heartbeat) ---

export type SystemState = {
  botName: string;
  discordTag: string | null;
  connected: boolean;
  guildCount: number;
  uptime: number;
  model: string;
  heartbeat: { running: boolean; handlers: number } | null;
  cronJobs: { name: string; enabled: boolean; nextRun: string | null }[];
};

let getSystemState: (() => SystemState) | null = null;

/**
 * Register a function that returns live system state.
 * Called from index.ts after all subsystems are initialized.
 */
export function setSystemStateProvider(provider: () => SystemState): void {
  getSystemState = provider;
}

let client: OpenAI;
let config: Config;

// Per-channel conversation history
const conversations = new Map<string, ChatMessage[]>();
const conversationLastUsed = new Map<string, number>();
const MAX_CONVERSATION_CHANNELS = 500;
const CONVERSATION_IDLE_MS = 6 * 60 * 60 * 1000;
let pruneTicker: ReturnType<typeof setInterval> | null = null;

// --- Conversation summaries (compacted history) ---

const SUMMARIES_FILE = "data/memory/summaries.json";
const MAX_SUMMARY_LENGTH = 4000;

type SummaryStore = Record<string, { summary: string; updatedAt: string }>;

let summaries: SummaryStore = {};

function loadSummaries(): void {
  try {
    if (existsSync(SUMMARIES_FILE)) {
      summaries = JSON.parse(readFileSync(SUMMARIES_FILE, "utf-8"));
    }
  } catch {
    summaries = {};
  }
}

function saveSummaries(): void {
  try {
    queueTextWrite(SUMMARIES_FILE, JSON.stringify(summaries, null, 2), { debounceMs: 250, atomic: true });
  } catch (err) {
    console.error("LLM: failed to save summaries:", err);
  }
}

// --- Conversation persistence ---

const CONVERSATIONS_FILE = "data/memory/conversations.json";

/** Persist all active conversations to disk. Synchronous for use in signal handlers. */
export function saveConversations(): void {
  try {
    const data: { channelId: string; messages: ChatMessage[]; savedAt: string }[] = [];
    for (const [channelId, messages] of conversations.entries()) {
      if (messages.length === 0) continue;
      data.push({ channelId, messages, savedAt: new Date().toISOString() });
    }

    queueTextWrite(CONVERSATIONS_FILE, JSON.stringify(data, null, 2), { debounceMs: 250, atomic: true });
    console.log(`LLM: saved ${data.length} conversation(s) to disk`);
  } catch (err) {
    console.error("LLM: failed to save conversations:", err);
  }
}

function loadConversations(): void {
  try {
    if (!existsSync(CONVERSATIONS_FILE)) return;

    const raw = readFileSync(CONVERSATIONS_FILE, "utf-8");
    const data: { channelId: string; messages: ChatMessage[] }[] = JSON.parse(raw);

    let loaded = 0;
    let totalSanitized = 0;
    for (const entry of data) {
      if (entry.channelId && Array.isArray(entry.messages) && entry.messages.length > 0) {
        const cleaned = sanitizeHistory(entry.messages);
        totalSanitized += cleaned;
        if (entry.messages.length > 0) {
          conversations.set(entry.channelId, entry.messages);
          conversationLastUsed.set(entry.channelId, Date.now());
          loaded++;
        }
      }
    }

    console.log(`LLM: restored ${loaded} conversation(s) from disk${totalSanitized > 0 ? ` (sanitized ${totalSanitized} poisoned entries)` : ""}`);
  } catch (err) {
    console.error("LLM: failed to load conversations:", err);
  }
}

// Queue of messages trimmed from history, keyed by channelId
const compactionQueue = new Map<string, ChatMessage[]>();

export function initLLM(cfg: Config): void {
  config = cfg;
  const transport = createLLMTransport(cfg);
  const openaiOptions: Record<string, unknown> = {
    baseURL: cfg.llm.baseURL,
    apiKey: cfg.llm.apiKey || undefined,
  };
  if (transport.fetch) openaiOptions.fetch = transport.fetch;
  client = new OpenAI(openaiOptions as ConstructorParameters<typeof OpenAI>[0]);
  loadSummaries();
  loadConversations();
  if (pruneTicker) clearInterval(pruneTicker);
  pruneTicker = setInterval(() => {
    pruneInactiveConversations();
  }, 10 * 60 * 1000);
}

/** Expose the initialized OpenAI client for lightweight direct calls (e.g. mood classification). */
export function getLLMClient(): OpenAI { return client; }
export function getLLMModel(): string { return config.llm.model; }
export function getAuxiliaryModel(): string { return config.llm.auxiliaryModel || config.llm.model; }
export function getDisableThinking(): boolean { return config.llm.disableThinking; }

/** Full session reset: clears history, summary, and compaction queue for a channel. */
export function clearSession(channelId: string): void {
  conversations.delete(channelId);
  conversationLastUsed.delete(channelId);
  compactionQueue.delete(channelId);
  if (summaries[channelId]) {
    delete summaries[channelId];
    saveSummaries();
  }
}

function getHistory(channelId: string): ChatMessage[] {
  if (!conversations.has(channelId)) {
    conversations.set(channelId, []);
  }
  conversationLastUsed.set(channelId, Date.now());
  if (conversations.size > MAX_CONVERSATION_CHANNELS) {
    pruneInactiveConversations();
  }
  return conversations.get(channelId)!;
}

function pruneInactiveConversations(): void {
  const now = Date.now();

  for (const [channelId, lastUsedAt] of conversationLastUsed.entries()) {
    if (now - lastUsedAt < CONVERSATION_IDLE_MS) continue;
    conversations.delete(channelId);
    compactionQueue.delete(channelId);
    conversationLastUsed.delete(channelId);
  }

  if (conversations.size <= MAX_CONVERSATION_CHANNELS) return;

  const ordered = [...conversationLastUsed.entries()]
    .sort((a, b) => a[1] - b[1]);
  const overflow = conversations.size - MAX_CONVERSATION_CHANNELS;
  for (let i = 0; i < overflow && i < ordered.length; i++) {
    const channelId = ordered[i][0];
    conversations.delete(channelId);
    compactionQueue.delete(channelId);
    conversationLastUsed.delete(channelId);
  }
}

/**
 * Remove poisoned entries from a conversation history array (in-place).
 * Targets:
 * - Assistant messages containing the formatting-error boilerplate
 * - Assistant messages with null/empty content (orphans from failed tool calls)
 * Returns the number of entries removed.
 */
function sanitizeHistory(history: ChatMessage[]): number {
  let removed = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i] as unknown as Record<string, unknown>;

    // Remove poisoned error responses
    if (
      msg.role === "assistant" &&
      typeof msg.content === "string" &&
      msg.content.startsWith("(I encountered a formatting issue")
    ) {
      history.splice(i, 1);
      removed++;
      continue;
    }

    // Remove assistant messages with null/empty content (orphaned from tool calls)
    if (
      msg.role === "assistant" &&
      (msg.content === null || msg.content === undefined || msg.content === "")
      && !msg.tool_calls
    ) {
      history.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

function trimHistory(history: ChatMessage[], channelId?: string): void {
  while (history.length > config.llm.maxHistory) {
    const removed = history.shift();
    if (removed && channelId) {
      if (!compactionQueue.has(channelId)) compactionQueue.set(channelId, []);
      compactionQueue.get(channelId)!.push(removed);
    }
  }
}

/**
 * Get an LLM response with per-channel conversation memory and tool/agent support.
 * Accepts string or ContentPart[] (for multimodal messages with images).
 */
export async function getLLMResponse(
  channelId: string,
  userMessage: UserContent,
  onToken?: OnTokenCallback,
  userId?: string,
  onToolCall?: OnToolCallCallback,
): Promise<string> {
  const llmStartTime = Date.now();
  broadcastEvent("mindmap", { type: "conversation:start", conversationId: channelId, userId, source: "discord", timestamp: new Date().toISOString() });
  broadcastEvent("mindmap", { type: "conversation:message", conversationId: channelId, role: "user", preview: truncatePreview(userMessage), timestamp: new Date().toISOString() });

  const history = getHistory(channelId);

  // Sanitize any poisoned entries from previous sessions or crashed requests
  const cleaned = sanitizeHistory(history);
  if (cleaned > 0) {
    console.log(`LLM: sanitized ${cleaned} poisoned history entries for channel ${channelId}`);
  }

  history.push({ role: "user", content: userMessage as string });
  trimHistory(history, channelId);

  const allDefs = getAllDefinitions();

  // Extract recent user messages as conversation context for semantic memory
  const recentUserMsgs = history
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .slice(-3)
    .map((m) => m.content as string)
    .join(" ");

  // Filter tools by relevance to the conversation, then apply lite mode if needed
  const filterContext = recentUserMsgs || (typeof userMessage === "string" ? userMessage : "");
  const relevantDefs = filterToolsByRelevance(allDefs, filterContext);
  const tools = config.llm.lite ? slimDefinitions(relevantDefs) : relevantDefs;

  const messages: ChatMessage[] = [
    { role: "system", content: await buildSystemPrompt(userId, channelId, recentUserMsgs || undefined) },
    ...history,
  ];

  // Immediate emotion reaction to user text (before LLM processes)
  if (typeof userMessage === "string") analyzeUserText(userMessage, channelId);

  // Create emotion stream analyzer for real-time 3D mesh updates
  const currentMood = loadMood();
  const emotionAnalyzer = new StreamEmotionAnalyzer(
    channelId,
    currentMood ? moodStateToVector(currentMood) : undefined,
  );
  // Emit initial emotion state so the client knows a conversation is active
  broadcastEvent("emotion", { ...(currentMood ? moodStateToVector(currentMood) : {}), conversationId: channelId, source: "stream" });

  try {
    const result = await runCompletionLoop(messages, tools, channelId, undefined, undefined, true, onToken, userId, onToolCall, emotionAnalyzer);

    // Don't save template-failure error responses to history  -  they poison
    // subsequent calls on models like Qwen whose Jinja templates are fragile
    if (!result.startsWith("(I encountered a formatting issue")) {
      history.push({ role: "assistant", content: result });
      trimHistory(history, channelId);
    } else {
      // Remove the user message that triggered the failure too
      history.pop();
    }

    broadcastEvent("mindmap", { type: "conversation:message", conversationId: channelId, role: "assistant", preview: truncatePreview(result), timestamp: new Date().toISOString() });
    broadcastEvent("mindmap", { type: "conversation:end", conversationId: channelId, totalDurationMs: Date.now() - llmStartTime, timestamp: new Date().toISOString() });
    return result;
  } catch (err) {
    // Remove the failed user message so history stays clean
    history.pop();
    broadcastEvent("mindmap", { type: "conversation:end", conversationId: channelId, totalDurationMs: Date.now() - llmStartTime, error: true, timestamp: new Date().toISOString() });
    throw err;
  }
}

/**
 * Frontend-issued system directive: produces an assistant turn framed as
 * "the system is asking the assistant to do X" rather than "the user is asking
 * for X". Use for proactive greetings, app-state-driven prompts, etc.
 *
 * No user message enters history. The assistant reply is appended so that
 * subsequent user turns retain continuity.
 */
export async function getSystemDirectiveResponse(
  channelId: string,
  directive: string,
  onToken?: OnTokenCallback,
  userId?: string,
  onToolCall?: OnToolCallCallback,
): Promise<string> {
  const llmStartTime = Date.now();
  broadcastEvent("mindmap", { type: "conversation:start", conversationId: channelId, userId, source: "system", timestamp: new Date().toISOString() });
  broadcastEvent("mindmap", { type: "conversation:message", conversationId: channelId, role: "system", preview: truncatePreview(directive), timestamp: new Date().toISOString() });

  const history = getHistory(channelId);
  const cleaned = sanitizeHistory(history);
  if (cleaned > 0) {
    console.log(`LLM: sanitized ${cleaned} poisoned history entries for channel ${channelId}`);
  }

  const allDefs = getAllDefinitions();
  const relevantDefs = filterToolsByRelevance(allDefs, directive);
  const tools = config.llm.lite ? slimDefinitions(relevantDefs) : relevantDefs;

  const messages: ChatMessage[] = [
    { role: "system", content: await buildSystemPrompt(userId, channelId) },
    ...history,
    { role: "system", content: `[SYSTEM DIRECTIVE — not from the user]\n${directive}` },
  ];

  const currentMood = loadMood();
  const emotionAnalyzer = new StreamEmotionAnalyzer(
    channelId,
    currentMood ? moodStateToVector(currentMood) : undefined,
  );
  broadcastEvent("emotion", { ...(currentMood ? moodStateToVector(currentMood) : {}), conversationId: channelId, source: "stream" });

  try {
    const result = await runCompletionLoop(messages, tools, channelId, undefined, undefined, true, onToken, userId, onToolCall, emotionAnalyzer);

    if (!result.startsWith("(I encountered a formatting issue")) {
      history.push({ role: "assistant", content: result });
      trimHistory(history, channelId);
    }

    broadcastEvent("mindmap", { type: "conversation:message", conversationId: channelId, role: "assistant", preview: truncatePreview(result), timestamp: new Date().toISOString() });
    broadcastEvent("mindmap", { type: "conversation:end", conversationId: channelId, totalDurationMs: Date.now() - llmStartTime, timestamp: new Date().toISOString() });
    return result;
  } catch (err) {
    broadcastEvent("mindmap", { type: "conversation:end", conversationId: channelId, totalDurationMs: Date.now() - llmStartTime, error: true, timestamp: new Date().toISOString() });
    throw err;
  }
}

/**
 * Stateless one-shot LLM call with tool/agent support (for cron, heartbeat, dashboard).
 */
export async function getLLMOneShot(prompt: string, onToken?: OnTokenCallback): Promise<string> {
  const allDefs = getAllDefinitions();
  const tools = config.llm.lite ? slimDefinitions(allDefs) : allDefs;

  const messages: ChatMessage[] = [
    { role: "system", content: await buildSystemPrompt() },
    { role: "user", content: prompt },
  ];

  return await runCompletionLoop(messages, tools, null, undefined, undefined, true, onToken);
}

// --- Agent loop support ---

export type AgentLoopOptions = {
  systemPrompt: string;
  userPrompt: string;
  toolAllowlist?: string[];
  maxIterations?: number;
  model?: string;
  channelId: string | null;
};

/**
 * Run a sub-agent's completion loop with its own system prompt and tool allowlist.
 * Agents can only call tools, not other agents (prevents recursive chains).
 *
 * The agent's system prompt is prefixed with the persona's voice context
 * (bootstrap + lore + soul) so agent responses stay in character. The agent's
 * own instructions follow as a "## Agent Task" section.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<string> {
  const {
    systemPrompt,
    userPrompt,
    toolAllowlist,
    maxIterations,
    model,
    channelId,
  } = options;

  const max = maxIterations ?? config.agents.maxIterations;
  const tools = resolveToolsForAllowlist(toolAllowlist);

  // Prepend persona voice so agents stay in character.
  // Uses the ambient prompt (bootstrap + lore + soul, no tools/skills noise).
  // Falls back to the agent's own prompt if no persona is loaded.
  const personaVoice = config.llm.ambientSystemPrompt;
  const fullSystemPrompt = personaVoice
    ? `${personaVoice}\n\n## Agent Task\n${systemPrompt}`
    : systemPrompt;

  const messages: ChatMessage[] = [
    { role: "system", content: fullSystemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Agent sub-loops: allowAgentDispatch=false (tools only, no recursive agents)
  return await runCompletionLoop(messages, tools, channelId, max, model, false);
}

// --- System prompt with dynamic tool/agent inventory ---

/**
 * Build the system prompt fresh each request.
 * Appends live system state and a live inventory of enabled tools/agents
 * so the LLM always knows the current state of its environment.
 */
export async function buildSystemPrompt(userId?: string, channelId?: string, conversationContext?: string): Promise<string> {
  const buildStart = Date.now();
  const base = config.llm.systemPrompt;
  const sections: string[] = [];

  // Kick off the only two network-bound fetches (memory semantic search + KB
  // vector search) immediately so they run in parallel with the sync section
  // assembly below. We await them just before they are needed.
  const memoryAndKbPromise = Promise.all([
    getMemoryForPrompt(userId ?? null, channelId ?? null, conversationContext),
    conversationContext && conversationContext.length >= 20
      ? searchKnowledgeBase(conversationContext).catch((err) => {
          console.warn("KnowledgeBase: search failed during prompt build:", err instanceof Error ? err.message : err);
          return [] as Awaited<ReturnType<typeof searchKnowledgeBase>>;
        })
      : Promise.resolve([] as Awaited<ReturnType<typeof searchKnowledgeBase>>),
  ]);

  // Sections ordered static → dynamic to maximize OpenAI prompt prefix caching.
  // The persona base prompt (above) is always the same, so it anchors the cache.

  // --- Tool/agent inventory (static  -  only changes on tool toggle) ---
  // Condensed: name only, the LLM gets full schemas via the tools array anyway.
  if (!config.llm.lite) {
    const tools = getEnabledTools();
    const agents = agentRegistryCache
      ? agentRegistryCache.getEnabledAgents()
      : [];

    if (tools.length > 0 || agents.length > 0) {
      const parts: string[] = ["\n\n## Currently Available"];

      if (tools.length > 0) {
        parts.push("Tools: " + tools.map((t) => t.name).join(", "));
      }
      if (agents.length > 0) {
        parts.push("Agents: " + agents.map((a) => a.name).join(", "));
      }

      sections.push(parts.join("\n"));
    }
  }

  // --- Current mood (semi-static  -  changes on mood shift) ---
  sections.push("\n\n" + buildMoodPromptSection());

  // --- Current user (semi-static  -  changes on new user or name change) ---
  if (userId) {
    const profile = getUser(userId);
    if (profile) {
      let userLine = `## Current User\nYou are talking to **${profile.username}**`;
      if (profile.messageCount > 1) {
        userLine += ` (${profile.messageCount} messages since ${new Date(profile.firstSeen).toLocaleDateString()})`;
      }
      userLine += ".";
      // Inject full user profile if available, else fall back to personality summary
      const userProfileContent = getProfileForPrompt(userId);
      if (userProfileContent) {
        userLine += "\n\n" + userProfileContent;
      } else if (profile.personalitySummary) {
        userLine += `\n\n${profile.personalitySummary.slice(0, 500)}`;
      }
      sections.push("\n\n" + userLine);
    }
  }

  // --- Current session (semi-static  -  changes on new message/participant) ---
  if (channelId) {
    const session = getSession(channelId);
    if (session) {
      const parts: string[] = [];
      if (session.channelName) parts.push(`Channel: #${session.channelName}`);
      const names = Object.values(session.users).map((u) => u.username);
      if (names.length > 0) parts.push(`Participants: ${names.join(", ")}`);
      if (parts.length > 0) {
        sections.push("\n\n## Current Session\n" + parts.join(" | "));
      }
    }
  }

  // --- Memory + Knowledge Base (semi-static) ---
  {
    const [memoryBlock, kbResults] = await memoryAndKbPromise;

    if (memoryBlock) {
      sections.push("\n\n" + memoryBlock);
      const factLines = memoryBlock.split("\n").filter((l) => l.startsWith("- "));
      broadcastEvent("mindmap", {
        type: "memory:search", conversationId: channelId ?? "unknown",
        resultCount: factLines.length,
        topFacts: factLines.slice(0, 5).map((l) => l.slice(2, 82)),
        timestamp: new Date().toISOString(),
      });
    }

    if (kbResults.length > 0) {
      broadcastEvent("mindmap", {
        type: "kb:search", conversationId: channelId ?? "unknown",
        resultCount: kbResults.length,
        fileNames: kbResults.map((r) => r.fileName),
        timestamp: new Date().toISOString(),
      });
      const kbLines = kbResults.map(
        (r) => `**${r.fileName}** (excerpt):\n> ${r.chunk.replace(/\n/g, "\n> ")}`,
      );
      sections.push(
        "\n\n## Reference Material\nThe following excerpts from shared documents may be relevant:\n\n" +
        kbLines.join("\n\n"),
      );
    }
  }

  // --- Conversation summary (dynamic  -  changes after compaction) ---
  if (channelId && summaries[channelId]) {
    sections.push(
      "\n\n## Recent Conversation Context\n" + summaries[channelId].summary,
    );
  }

  // --- Current date/time (dynamic  -  changes every request) ---
  {
    const tz = config.timezone || "UTC";
    const now = new Date().toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    sections.push(`\n\n## Current Date & Time\n${now} (${tz})`);
  }

  // System status (uptime, heartbeat, cron) omitted to save prompt space.
  // The bot gets tool schemas via the tools array; runtime state is rarely needed.

  const buildMs = Date.now() - buildStart;
  if (buildMs > 250) {
    console.warn(`LLM: buildSystemPrompt slow (${buildMs}ms) — hot-path IO regression?`);
  }

  if (sections.length === 0) return base;
  return base + sections.join("");
}

/**
 * Render tool calls/results into assistant+user messages without using OpenAI tool roles.
 * This preserves compatibility with providers whose chat templates break on tool-role messages.
 */
export function renderToolRoundMessages(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
  toolResults: { name: string; result: string }[],
  assistantPreface?: string | null,
): ToolLoopRenderResult {
  let assistantContent = assistantPreface ?? "";

  for (const tc of toolCalls) {
    let callStr = `<tool_call>\n<function=${tc.function.name}>\n`;
    try {
      const parsed = JSON.parse(safeToolArgs(tc.function.arguments));
      for (const [key, value] of Object.entries(parsed)) {
        const valueStr = typeof value === "object" && value !== null
          ? JSON.stringify(value)
          : String(value);
        callStr += `<parameter=${key}>\n${valueStr}\n</parameter>\n`;
      }
    } catch {
      // Skip malformed arguments and still preserve the function call shell.
    }
    callStr += `</function>\n</tool_call>`;
    assistantContent += (assistantContent.trim() ? "\n\n" : "") + callStr;
  }

  const toolResponseParts: string[] = [];
  for (let ti = 0; ti < toolCalls.length; ti++) {
    let resultContent = toolResults[ti].result;
    if (resultContent.startsWith("Error:")) {
      resultContent = `TOOL FAILED - ${resultContent}\nYou MUST report this failure to the user. Do NOT claim this action succeeded.`;
    }
    toolResponseParts.push(`<tool_response>\n${resultContent}\n</tool_response>`);
  }

  return {
    assistantContent,
    userContent: toolResponseParts.join("\n"),
  };
}

// --- Conversation compaction ---

/**
 * Compact pending trimmed history for channels that have accumulated enough messages.
 * Uses a direct LLM call (no tool dispatch) to avoid recursion.
 * Only fires the LLM call when a channel has >= minQueueSize queued messages.
 */
export async function compactPendingHistory(minQueueSize = 5): Promise<number> {
  let compacted = 0;

  for (const [channelId, queue] of compactionQueue.entries()) {
    if (queue.length < minQueueSize) continue;

    // Drain the queue
    const messages = queue.splice(0, queue.length);
    if (queue.length === 0) compactionQueue.delete(channelId);

    // Format the messages for summarization
    const formatted = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${text.slice(0, 500)}`;
      })
      .join("\n");

    if (!formatted) continue;

    try {
      const existing = summaries[channelId]?.summary ?? "";
      const contextNote = existing
        ? `Previous summary:\n${existing}\n\nNew messages to incorporate:\n`
        : "Messages to summarize:\n";

      const compactStart = Date.now();
      const compactUserContent = contextNote + formatted;
      const completion = await client.chat.completions.create({
        model: config.llm.auxiliaryModel || config.llm.model,
        max_completion_tokens: 4096,
        ...(getDisableThinking() ? { enable_thinking: false } : {}),
        messages: [
          {
            role: "system",
            content:
              "You are a conversation history compressor. Preserve maximum useful information in minimum space.\n\n" +
              "Preserve specifically:\n" +
              "- Names and identifiers (people, projects, tools, places)\n" +
              "- Decisions made or preferences expressed\n" +
              "- Key facts shared (personal details, technical context)\n" +
              "- Action items, commitments, or plans\n" +
              "- Emotional tone and relationship context\n\n" +
              "Dense paragraph form. No bullet lists. No preamble. Keep under 2000 characters.",
          },
          { role: "user", content: getDisableThinking() ? `/no_think\n${compactUserContent}` : compactUserContent },
        ],
      });

      const compactModel = config.llm.auxiliaryModel || config.llm.model;
      recordCompletionUsage(completion, compactModel, "compaction");
      const rawSummary = completion.choices[0]?.message?.content?.trim();
      const summary = rawSummary ? stripThinkBlocks(rawSummary).trim() : "";
      if (summary) {
        summaries[channelId] = {
          summary: summary.slice(0, MAX_SUMMARY_LENGTH),
          updatedAt: new Date().toISOString(),
        };
        saveSummaries();
        compacted++;
        console.log(`LLM: compaction ${Date.now() - compactStart}ms, ${messages.length} messages for channel ${channelId}`);
      }
    } catch (err) {
      console.error(`LLM: compaction failed for channel ${channelId}:`, err);
      // Put messages back so they aren't lost
      if (!compactionQueue.has(channelId)) compactionQueue.set(channelId, []);
      compactionQueue.get(channelId)!.unshift(...messages);
    }
  }

  return compacted;
}

/** Get all conversation summaries (for dashboard API). */
export function getConversationSummaries(): SummaryStore {
  return { ...summaries };
}

// --- Internal helpers ---

/** Merge tool + agent definitions for the main agent's OpenAI calls. */
function getAllDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  if (agentRegistryCache) {
    return [
      ...getToolDefinitionsForOpenAI(),
      ...agentRegistryCache.getAgentDefinitionsForOpenAI(),
    ];
  }
  return getToolDefinitionsForOpenAI();
}

// --- Dynamic tool filtering ---

/** Tools that are always included regardless of relevance scoring. */
const CORE_TOOLS = new Set([
  "ping", "date", "memory", "cron", "notes", "set_mood",
]);

/** Minimum number of tools to include (prevents over-filtering). */
const MIN_TOOLS = 8;

/**
 * Filter tool definitions by relevance to the user's message.
 * Uses lightweight keyword overlap — no embedding API calls.
 * Core tools are always included; specialized tools need keyword relevance.
 */
function filterToolsByRelevance(
  defs: OpenAI.Chat.Completions.ChatCompletionTool[],
  userContext: string,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  if (!userContext || defs.length <= MIN_TOOLS) return defs;

  const contextTokens = new Set(
    userContext.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((t) => t.length > 2),
  );
  if (contextTokens.size === 0) return defs;

  type Scored = { def: OpenAI.Chat.Completions.ChatCompletionTool; score: number; core: boolean };

  const scored: Scored[] = defs.map((def) => {
    const name = def.function.name;
    const core = CORE_TOOLS.has(name);

    // Build searchable text from tool name + description
    const searchText = `${name} ${def.function.description ?? ""}`.toLowerCase();
    const toolTokens = searchText.replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((t) => t.length > 2);

    // Count matching tokens
    let matches = 0;
    for (const token of toolTokens) {
      if (contextTokens.has(token)) matches++;
    }
    // Boost for name match (tool name directly mentioned)
    const nameTokens = name.toLowerCase().replace(/_/g, " ").split(/\s+/);
    for (const nt of nameTokens) {
      if (contextTokens.has(nt)) matches += 3;
    }

    return { def, score: matches, core };
  });

  // Always include core tools + any with relevance score > 0
  const included = scored.filter((s) => s.core || s.score > 0);

  // If we filtered too aggressively, backfill with top-scored remaining
  if (included.length < MIN_TOOLS) {
    const remaining = scored
      .filter((s) => !s.core && s.score === 0)
      .sort((a, b) => b.score - a.score);
    while (included.length < MIN_TOOLS && remaining.length > 0) {
      included.push(remaining.shift()!);
    }
  }

  // If filtering didn't remove anything meaningful, just return all
  if (included.length >= defs.length - 2) return defs;

  return included.map((s) => s.def);
}

/** Shorten tool descriptions for lite mode  -  first sentence only, trim param descriptions. */
function slimDefinitions(
  defs: OpenAI.Chat.Completions.ChatCompletionTool[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return defs.map((d) => ({
    type: "function" as const,
    function: {
      name: d.function.name,
      description: firstSentence(d.function.description ?? ""),
      ...(d.function.parameters
        ? { parameters: slimParameters(d.function.parameters as Record<string, unknown>) }
        : {}),
    },
  }));
}

function firstSentence(s: string): string {
  const dot = s.indexOf(". ");
  return dot >= 0 ? s.slice(0, dot + 1) : s;
}

function slimParameters(params: Record<string, unknown>): Record<string, unknown> {
  const props = params.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return params;

  const slimmed: Record<string, Record<string, unknown>> = {};
  for (const [key, val] of Object.entries(props)) {
    const { description, ...rest } = val;
    slimmed[key] = {
      ...rest,
      ...(typeof description === "string" ? { description: firstSentence(description) } : {}),
    };
  }

  return { ...params, properties: slimmed };
}

/** Filter tool definitions to only those in an agent's allowlist. */
function resolveToolsForAllowlist(
  allowlist: string[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  if (!allowlist || allowlist.length === 0) return [];
  if (allowlist.includes("*")) return getToolDefinitionsForOpenAI();
  return getToolDefinitionsForOpenAI().filter((t) =>
    allowlist.includes(t.function.name),
  );
}

/**
 * Derive a prompt_cache_key for the current turn. Scope controls how aggressively
 * concurrent turns share a cached prefix; "persona+channel" is the default and
 * maximises per-conversation cache hits without polluting across personas.
 * Returns undefined when prompt caching is disabled in config.
 */
function buildPromptCacheKey(channelId: string | null): string | undefined {
  if (!config.llm.promptCacheEnabled) return undefined;
  const persona = config.persona.activePersona || "default";
  const scope = config.llm.promptCacheScope;
  const channel = channelId ?? "global";
  switch (scope) {
    case "persona": return persona;
    case "channel": return channel;
    case "persona+channel":
    default:        return `${persona}:${channel}`;
  }
}

// Cache for agent registry (set after agents are loaded to break circular dep)
let agentRegistryCache: typeof import("./agent-registry.js") | null = null;

/** Call once after agents are loaded to enable agent dispatch in the main loop. */
export function enableAgentDispatch(
  mod: typeof import("./agent-registry.js"),
): void {
  agentRegistryCache = mod;
}

/**
 * Core completion loop that handles tool/agent calls.
 * Loops until the LLM produces a final text response or we hit the iteration cap.
 *
 * @param allowAgentDispatch If true, check whether called functions are agents. False for sub-agent loops.
 */
async function runCompletionLoop(
  messages: ChatMessage[],
  tools: OpenAI.Chat.Completions.ChatCompletionTool[],
  channelId: string | null,
  maxIterations = config.llm.maxToolIterations,
  model?: string,
  allowAgentDispatch = true,
  onToken?: OnTokenCallback,
  userId?: string,
  onToolCall?: OnToolCallCallback,
  emotionAnalyzer?: StreamEmotionAnalyzer,
): Promise<string> {
  const resolvedModel = model ?? config.llm.model;
  const runtime = selectProviderRuntime(config);
  let activeTools = tools;

  // Tool call JSON (long prompts + URLs) can exceed a low token cap.
  // Reasoning models also consume hidden tokens, so use a generous floor.
  const TOKEN_FLOOR_WITH_TOOLS = 16384;
  const resolveMaxOutputTokens = (): number | undefined =>
    activeTools.length > 0
      ? Math.max(config.llm.maxTokens || TOKEN_FLOOR_WITH_TOOLS, TOKEN_FLOOR_WITH_TOOLS)
      : config.llm.maxTokens || undefined;

  console.log(
    `LLM: request start (runtime=${runtime.kind}, model=${resolvedModel}, messages=${messages.length}, tools=${activeTools.length}, max_tokens=${resolveMaxOutputTokens() ?? "unset"})`,
  );

  const allToolRecords: ToolRecord[] = [];
  let intentNudgeFired = false;
  let toolsDropped = false;
  let contextTrimmed = false;
  let historyCleared = false;

  /** Extract the last user message content from the messages array. */
  function getLastUserContent(): UserContent | null {
    for (let j = messages.length - 1; j >= 0; j--) {
      if (messages[j].role === "user") {
        return (messages[j] as { content: UserContent }).content;
      }
    }
    return null;
  }

  /**
   * Auto-recover from persistent template errors by clearing history.
   * Returns true if recovery was initiated (caller should `continue`),
   * false if recovery isn't possible (caller should return error).
   */
    async function autoRecoverHistory(): Promise<boolean> {
    if (!channelId || historyCleared) return false;

    const lastUserContent = getLastUserContent();
    if (!lastUserContent) return false;

    console.warn(`LLM: persistent template error  -  auto-clearing history for channel ${channelId}`);
    clearSession(channelId);

    // Rebuild messages to just [system prompt, last user message]
    messages.length = 0;
    messages.push(
      { role: "system", content: await buildSystemPrompt(userId, channelId) },
      { role: "user", content: lastUserContent as string },
    );

    // Re-add tools since the issue was history, not tools
    if (tools.length > 0) {
      activeTools = tools;
      toolsDropped = false;
    }
    historyCleared = true;

    console.log(`LLM: retrying with clean slate (messages=${messages.length}, tools=${activeTools.length})`);
    return true;
  }

  /**
   * Trim oldest history messages (preserving system prompt + last user message)
   * to reduce context size. Returns true if messages were actually removed.
   */
  function trimForContext(): boolean {
    // Keep system prompt (index 0) and at least the last 2 messages
    if (messages.length <= 3) return false;
    const before = messages.length;
    // Remove ~half of the history messages (between system prompt and the last 4 messages)
    const removable = messages.length - 5; // keep system + last 4
    if (removable <= 0) return false;
    const toRemove = Math.max(2, Math.ceil(removable / 2));
    messages.splice(1, toRemove);
    console.warn(`LLM: context overflow, trimmed ${before - messages.length} messages (${before} -> ${messages.length})`);
    return true;
  }

  for (let i = 0; i < maxIterations; i++) {
    let content: string | null;
    let toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined;
    const apiStart = Date.now();
    let ttftMs: number | null = null;
    const thinkFilter = onToken ? new ThinkBlockFilter(onToken) : null;

    try {
      const result = await runtime.runTurn({
        client,
        model: resolvedModel,
        messages,
        tools: activeTools,
        maxOutputTokens: resolveMaxOutputTokens(),
        stream: !!onToken,
        userId,
        promptCacheKey: buildPromptCacheKey(channelId),
        onTextDelta: onToken
          ? (delta) => {
              if (ttftMs === null) ttftMs = Date.now() - apiStart;
              thinkFilter?.push(delta);
              emotionAnalyzer?.push(delta);
            }
          : undefined,
      });

      thinkFilter?.flush();
      emotionAnalyzer?.flush();

      const apiMs = Date.now() - apiStart;
      if (result.usage?.totalTokens !== undefined) {
        const cached = result.usage.cachedTokens ?? 0;
        console.log(
          `LLM: response ${apiMs}ms${ttftMs !== null ? ` TTFT=${ttftMs}ms` : ""} (in=${result.usage.inputTokens ?? "?"}, out=${result.usage.outputTokens ?? "?"}, total=${result.usage.totalTokens}${cached > 0 ? `, cached=${cached}` : ""})`,
        );
        recordUsage({
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          reasoningTokens: result.usage.reasoningTokens ?? 0,
          cachedTokens: cached,
          model: config.llm.model,
          source: "chat",
        });
      } else {
        console.log(`LLM: response ${apiMs}ms${ttftMs !== null ? ` TTFT=${ttftMs}ms` : ""}`);
      }
      broadcastEvent("mindmap", {
        type: "llm:iteration",
        conversationId: channelId ?? "unknown",
        iteration: i + 1,
        durationMs: apiMs,
        timestamp: new Date().toISOString(),
      });

      content = result.content ? stripThinkBlocks(result.content) || null : null;
      if (result.toolCalls && result.toolCalls.length > 0) {
        toolCalls = result.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
        for (const tc of toolCalls) {
          console.log(`LLM: tool_call raw args for ${tc.function.name}: ${tc.function.arguments.slice(0, 500)}`);
        }
      }
    } catch (err) {
      thinkFilter?.flush();
      emotionAnalyzer?.flush();

      if (!contextTrimmed && isContextSizeError(err) && trimForContext()) {
        contextTrimmed = true;
        continue;
      }
      if (isToolTemplateError(err)) {
        if (activeTools.length > 0) {
          console.warn("LLM: model template error, retrying without tools");
          activeTools = [];
          toolsDropped = true;
          continue;
        }
        if (await autoRecoverHistory()) continue;
        console.warn("LLM: model template rejected message format:", (err as Error).message ?? err);
        return "(I encountered a formatting issue and couldn't process that request.)";
      }
      throw err;
    }

    // If the model wants to call tools/agents
    if (toolCalls && toolCalls.length > 0) {
      // Notify caller that tools are about to run (so UI can show a clean status)
      if (onToolCall) {
        onToolCall(toolCalls.map((tc) => tc.function.name));
      }

      // Parse all tool call args up front and classify as agent vs tool
      const parsed = toolCalls.map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(safeToolArgs(tc.function.arguments));
        } catch {
          console.warn(`LLM: invalid JSON in tool call args for ${tc.function.name}: ${(tc.function.arguments || "").slice(0, 300)}`);
        }
        const isAgent = allowAgentDispatch && agentRegistryCache?.isAgent(tc.function.name);
        return { tc, args, isAgent };
      });

      // Execute tool calls — tools run in parallel, agents run sequentially
      const toolResults: { name: string; result: string }[] = new Array(parsed.length);

      // Run all non-agent tool calls in parallel
      const toolPromises = parsed.map(async ({ tc, args, isAgent }, idx) => {
        if (isAgent) return; // agents handled below

        console.log(`LLM: calling tool "${tc.function.name}"`);
        broadcastEvent("mindmap", {
          type: "tool:start", conversationId: channelId ?? "unknown",
          toolName: tc.function.name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 200) : v])),
          timestamp: new Date().toISOString(),
        });

        const toolStart = Date.now();
        const result = await executeToolText(tc.function.name, args, channelId, userId);

        broadcastEvent("mindmap", {
          type: "tool:end", conversationId: channelId ?? "unknown",
          toolName: tc.function.name, success: !result.startsWith("Error:"),
          preview: result.slice(0, 120), durationMs: Date.now() - toolStart,
          timestamp: new Date().toISOString(),
        });

        toolResults[idx] = { name: tc.function.name, result };
      });

      await Promise.all(toolPromises);

      // Run agent calls sequentially (heavyweight sub-loops, may have ordering dependencies)
      for (let idx = 0; idx < parsed.length; idx++) {
        const { tc, args, isAgent } = parsed[idx];
        if (!isAgent) continue;

        console.log(`LLM: calling agent "${tc.function.name}"`);
        broadcastEvent("mindmap", {
          type: "tool:start", conversationId: channelId ?? "unknown",
          toolName: tc.function.name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 200) : v])),
          timestamp: new Date().toISOString(),
        });

        const toolStart = Date.now();
        const result = await agentRegistryCache!.executeAgent(tc.function.name, args, channelId);

        broadcastEvent("mindmap", {
          type: "tool:end", conversationId: channelId ?? "unknown",
          toolName: tc.function.name, success: !result.startsWith("Error:"),
          preview: result.slice(0, 120), durationMs: Date.now() - toolStart,
          timestamp: new Date().toISOString(),
        });

        toolResults[idx] = { name: tc.function.name, result };
      }

      // Track tool records for post-response verification
      for (const t of toolResults) {
        allToolRecords.push({
          name: t.name,
          result: t.result,
          failed: t.result.startsWith("Error:"),
        });
      }

      const renderedToolRound = renderToolRoundMessages(toolCalls, toolResults, content);
      messages.push({ role: "assistant", content: renderedToolRound.assistantContent } as ChatMessage);
      messages.push({ role: "user", content: renderedToolRound.userContent } as ChatMessage);

      continue;
    }

    // No tool calls  -  final text response (safety-net strip for any leaked reasoning)
    console.log(`LLM: completed in ${i + 1} iteration(s)`);
    const final = content ? stripThinkBlocks(content) : null;
    const finalText = final?.trim() || "(no response)";

    // Post-response verification: detect phantom claims and ignored errors
    if (config.llm.verifyToolClaims && finalText !== "(no response)") {
      const correction = detectPhantomClaims(finalText, allToolRecords);
      if (correction) {
        console.warn("LLM: phantom tool claim detected, running correction pass");
        const corrected = await runCorrectionPass(messages, finalText, correction);
        if (corrected) return corrected;
      }
    }

    // Deferred intent detection: model said "let me check X" but never called a tool.
    // Nudge it to follow through. Only fires once per completion to prevent loops.
    if (
      !intentNudgeFired &&
      !toolsDropped &&
      activeTools.length > 0 &&
      !toolCalls &&
      isUnfulfilledIntent(finalText)
    ) {
      intentNudgeFired = true;
      console.warn(`LLM: deferred intent detected ("${finalText.slice(0, 80)}…"), nudging to follow through`);
      messages.push({ role: "assistant", content: finalText });
      messages.push({
        role: "user",
        content: "[SYSTEM: You announced you would take an action but didn't use any tools. Please use the appropriate tool now to complete it, or give your final answer if no tool is needed.]",
      });
      continue;
    }

    return finalText;
  }

  console.warn(`LLM: hit max tool iterations (${maxIterations})`);
  return "(reached maximum tool call depth)";
}

// Matches short responses that announce a pending action but include no tool call.
// Uses a broad "let me <verb>" pattern excluding conversational non-action words,
// rather than an ever-growing allowlist of specific verbs.
const DEFERRED_INTENT_RE =
  /\b(let me (?!know\b|explain\b|clarify\b|be\b|just\b|show you\b)\w+|i'?ll (check|look|pull|grab|get|fetch|find|access|query|try|retry|search|run|call|use|fix|correct|format|adjust|update)|i'?m (checking|looking|pulling|getting|fetching|finding|trying|searching|calling|fixing)|give me (a )?(sec|moment)|one (sec|moment)|just a (sec|moment))\b/i;

function isUnfulfilledIntent(text: string): boolean {
  // Only flag short responses  -  a long one almost certainly contains the actual answer
  return text.length < 280 && DEFERRED_INTENT_RE.test(text);
}

/**
 * Rewrite tool call argument JSON so large integer literals (Discord snowflakes,
 * etc.) are preserved as strings instead of being rounded by JSON.parse.
 * Any unquoted number >= 2^53 is wrapped in quotes before parsing.
 */
function safeToolArgs(raw: string): string {
  // Replace bare integer literals that exceed Number.MAX_SAFE_INTEGER with quoted strings.
  // Only match numbers in JSON value positions (after : , or [) followed by , } or ].
  // This avoids corrupting numbers inside string values (e.g. Discord CDN URLs).
  return raw.replace(/([:,\[]\s*)(\d{16,})(\s*[,}\]])/g, '$1"$2"$3');
}

/**
 * Run a correction pass when phantom tool claims are detected.
 * Asks the LLM to rewrite its response without tool access.
 */
async function runCorrectionPass(
  messages: ChatMessage[],
  originalResponse: string,
  correctionPrompt: string,
): Promise<string | null> {
  try {
    const correctionMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: originalResponse },
      { role: "user", content: correctionPrompt },
    ];

    const completion = await client.chat.completions.create({
      model: config.llm.model,
      messages: correctionMessages,
      max_completion_tokens: config.llm.maxTokens || undefined,
      // No tools  -  prevent further tool calls during correction
    });

    recordCompletionUsage(completion, config.llm.model, "correction");
    const corrected = completion.choices[0]?.message?.content;
    if (corrected) {
      const final = stripThinkBlocks(corrected).trim();
      if (final) {
        console.log("LLM: correction pass produced revised response");
        return final;
      }
    }
  } catch (err) {
    if (isToolTemplateError(err)) {
      console.warn("LLM: correction pass skipped (template incompatibility)");
    } else {
      console.error("LLM: correction pass failed:", err);
    }
  }

  // Fall back to original if correction fails
  return null;
}

import OpenAI from "openai";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { Config } from "./config.js";
import {
  getToolDefinitionsForOpenAI,
  getEnabledTools,
  executeTool,
} from "./tool-registry.js";
import { getMemoryForPrompt } from "./memory.js";
import { buildMoodPromptSection } from "./mood.js";
import { getUser } from "./users.js";
import { getSession } from "./sessions.js";
import { detectPhantomClaims, type ToolRecord } from "./tool-claim-detector.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type UserContent = string | ContentPart[];

/** Called for each text token during streaming. */
export type OnTokenCallback = (token: string) => void;

// --- Error detection for models whose templates don't support tool calling ---

function isToolTemplateError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message
    : typeof err === "object" && err !== null ? JSON.stringify(err)
    : String(err);
  return /jinja template|no user query found/i.test(msg);
}


// --- Think-block stripping (for reasoning models like Qwen, DeepSeek) ---

/** Strip reasoning/thinking content from LLM output (handles multiple model formats). */
function stripThinkBlocks(text: string): string {
  return text
    // <think>…</think> tags (Qwen, DeepSeek)
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .replace(/<think>[\s\S]*$/g, "")
    // <reasoning>…</reasoning> tags (some models)
    .replace(/<reasoning>[\s\S]*?<\/reasoning>\s*/g, "")
    .replace(/<reasoning>[\s\S]*$/g, "")
    // Orphaned closing tags (model splits thinking across content boundaries)
    .replace(/^\s*<\/think>\s*/g, "")
    .replace(/^\s*<\/reasoning>\s*/g, "")
    // Grok-style plain-text "Thinking Process:" blocks at the start
    .replace(/^Thinking Process:[\s\S]*?\n\n/i, "")
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
    const dir = "data/memory";
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SUMMARIES_FILE, JSON.stringify(summaries, null, 2), "utf-8");
  } catch (err) {
    console.error("LLM: failed to save summaries:", err);
  }
}

// --- Conversation persistence ---

const CONVERSATIONS_FILE = "data/memory/conversations.json";

/** Persist all active conversations to disk. Synchronous for use in signal handlers. */
export function saveConversations(): void {
  try {
    const dir = "data/memory";
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data: { channelId: string; messages: ChatMessage[]; savedAt: string }[] = [];
    for (const [channelId, messages] of conversations.entries()) {
      if (messages.length === 0) continue;
      data.push({ channelId, messages, savedAt: new Date().toISOString() });
    }

    writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
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
    for (const entry of data) {
      if (entry.channelId && Array.isArray(entry.messages) && entry.messages.length > 0) {
        conversations.set(entry.channelId, entry.messages);
        loaded++;
      }
    }

    console.log(`LLM: restored ${loaded} conversation(s) from disk`);
  } catch (err) {
    console.error("LLM: failed to load conversations:", err);
  }
}

// Queue of messages trimmed from history, keyed by channelId
const compactionQueue = new Map<string, ChatMessage[]>();

export function initLLM(cfg: Config): void {
  config = cfg;
  client = new OpenAI({
    baseURL: cfg.llm.baseURL,
    apiKey: cfg.llm.apiKey || undefined,
  });
  loadSummaries();
  loadConversations();
}

/** Expose the initialized OpenAI client for lightweight direct calls (e.g. mood classification). */
export function getLLMClient(): OpenAI { return client; }
export function getLLMModel(): string { return config.llm.model; }

/** Full session reset: clears history, summary, and compaction queue for a channel. */
export function clearSession(channelId: string): void {
  conversations.delete(channelId);
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
  return conversations.get(channelId)!;
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
): Promise<string> {
  const history = getHistory(channelId);

  history.push({ role: "user", content: userMessage as string });
  trimHistory(history, channelId);

  const allDefs = getAllDefinitions();
  const tools = config.llm.lite ? slimDefinitions(allDefs) : allDefs;

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(userId, channelId) },
    ...history,
  ];

  try {
    const result = await runCompletionLoop(messages, tools, channelId, undefined, undefined, true, onToken, userId);

    history.push({ role: "assistant", content: result });
    trimHistory(history, channelId);

    return result;
  } catch (err) {
    // Remove the failed user message so history stays clean
    history.pop();
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
    { role: "system", content: buildSystemPrompt() },
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

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
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
function buildSystemPrompt(userId?: string, channelId?: string): string {
  const base = config.llm.systemPrompt;
  const sections: string[] = [];

  // Sections ordered static → dynamic to maximize OpenAI prompt prefix caching.
  // The persona base prompt (above) is always the same, so it anchors the cache.

  // --- Tool/agent inventory (static — only changes on tool toggle) ---
  if (!config.llm.lite) {
    const tools = getEnabledTools();
    const agents = agentRegistryCache
      ? agentRegistryCache.getEnabledAgents()
      : [];

    if (tools.length > 0 || agents.length > 0) {
      const lines: string[] = ["\n\n## Currently Available"];

      if (tools.length > 0) {
        lines.push("\n### Tools");
        for (const t of tools) {
          lines.push(`- **${t.name}** — ${t.description}`);
        }
      }

      if (agents.length > 0) {
        lines.push("\n### Agents");
        for (const a of agents) {
          lines.push(`- **${a.name}** — ${a.description}`);
        }
      }

      sections.push(lines.join("\n"));
    }
  }

  // --- Current mood (semi-static — changes on mood shift) ---
  sections.push("\n\n" + buildMoodPromptSection());

  // --- Current user (semi-static — changes on new user or name change) ---
  if (userId) {
    const profile = getUser(userId);
    if (profile) {
      let userLine = `## Current User\nYou are talking to **${profile.username}**`;
      if (profile.messageCount > 1) {
        userLine += ` (${profile.messageCount} messages since ${new Date(profile.firstSeen).toLocaleDateString()})`;
      }
      userLine += ".";
      sections.push("\n\n" + userLine);
    }
  }

  // --- Current session (semi-static — changes on new message/participant) ---
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

  // --- Memory (semi-static — changes on fact save) ---
  const memoryBlock = getMemoryForPrompt(userId ?? null, channelId ?? null);
  if (memoryBlock) sections.push("\n\n" + memoryBlock);

  // --- Conversation summary (dynamic — changes after compaction) ---
  if (channelId && summaries[channelId]) {
    sections.push(
      "\n\n## Recent Conversation Context\n" + summaries[channelId].summary,
    );
  }

  // --- Current date/time (dynamic — changes every request) ---
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

  // --- System state (most dynamic — uptime changes every request, goes last) ---
  if (!config.llm.lite) {
    const state = getSystemState?.();
    if (state) {
      const lines: string[] = ["\n\n## System Status"];
      lines.push(`- **Bot**: ${state.botName}${state.discordTag ? ` (${state.discordTag})` : ""}`);
      lines.push(`- **Discord**: ${state.connected ? "connected" : "disconnected"}, ${state.guildCount} guild(s)`);
      lines.push(`- **Model**: ${state.model}`);

      const h = Math.floor(state.uptime / 3600);
      const m = Math.floor((state.uptime % 3600) / 60);
      lines.push(`- **Uptime**: ${h}h ${m}m`);

      if (state.heartbeat) {
        lines.push(`- **Heartbeat**: ${state.heartbeat.running ? "running" : "stopped"}, ${state.heartbeat.handlers} handler(s)`);
      }

      const enabledCron = state.cronJobs.filter((j) => j.enabled);
      if (enabledCron.length > 0) {
        lines.push(`- **Cron**: ${enabledCron.length} active job(s)`);
      }

      sections.push(lines.join("\n"));
    }
  }

  if (sections.length === 0) return base;
  return base + sections.join("");
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
      const completion = await client.chat.completions.create({
        model: config.llm.model,
        max_completion_tokens: 800,
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
          { role: "user", content: contextNote + formatted },
        ],
      });

      const summary = completion.choices[0]?.message?.content?.trim();
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

/** Shorten tool descriptions for lite mode — first sentence only, trim param descriptions. */
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
): Promise<string> {
  const baseParams: {
    model: string;
    messages: ChatMessage[];
    max_completion_tokens: number | undefined;
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  } = {
    model: model ?? config.llm.model,
    messages,
    max_completion_tokens: config.llm.maxTokens || undefined,
    ...(tools.length > 0 ? { tools } : {}),
  };

  console.log(`LLM: request start (model=${baseParams.model}, messages=${messages.length}, tools=${tools.length})`);

  const allToolRecords: ToolRecord[] = [];

  for (let i = 0; i < maxIterations; i++) {
    let content: string | null;
    let toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined;

    if (onToken) {
      // --- Streaming path ---
      const apiStart = Date.now();
      let stream;
      try {
        stream = await client.chat.completions.create({ ...baseParams, stream: true });
      } catch (err) {
        if (isToolTemplateError(err)) {
          if (baseParams.tools) {
            console.warn("LLM: model template incompatible with tool definitions, retrying without tools");
            delete baseParams.tools;
            stream = await client.chat.completions.create({ ...baseParams, stream: true });
          } else {
            console.warn("LLM: model template rejected message format:", (err as Error).message ?? err);
            return "(I encountered a formatting issue and couldn't process that request.)";
          }
        } else {
          throw err;
        }
      }

      let contentAccum = "";
      const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();
      const thinkFilter = new ThinkBlockFilter(onToken);

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          contentAccum += delta.content;
          thinkFilter.push(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallAccum.has(tc.index)) {
              toolCallAccum.set(tc.index, { id: "", name: "", arguments: "" });
            }
            const accum = toolCallAccum.get(tc.index)!;
            if (tc.id) accum.id = tc.id;
            if (tc.function?.name) accum.name += tc.function.name;
            if (tc.function?.arguments) accum.arguments += tc.function.arguments;
          }
        }

        // Capture usage from final chunk (if API supports it)
        const chunkAny = chunk as unknown as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
        if (chunkAny.usage) {
          const u = chunkAny.usage;
          console.log(`LLM: tokens (in=${u.prompt_tokens}, out=${u.completion_tokens}, total=${u.total_tokens})`);
        }
      }

      thinkFilter.flush();
      console.log(`LLM: stream complete ${Date.now() - apiStart}ms`);

      content = stripThinkBlocks(contentAccum) || null;

      if (toolCallAccum.size > 0) {
        toolCalls = [...toolCallAccum.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          }));
      }
    } else {
      // --- Non-streaming path ---
      const apiStart = Date.now();
      let completion;
      try {
        completion = await client.chat.completions.create(baseParams);
      } catch (err) {
        if (isToolTemplateError(err)) {
          if (baseParams.tools) {
            console.warn("LLM: model template incompatible with tool definitions, retrying without tools");
            delete baseParams.tools;
            completion = await client.chat.completions.create(baseParams);
          } else {
            console.warn("LLM: model template rejected message format:", (err as Error).message ?? err);
            return "(I encountered a formatting issue and couldn't process that request.)";
          }
        } else {
          throw err;
        }
      }
      const apiMs = Date.now() - apiStart;
      const choice = completion.choices[0];
      if (!choice) return "(no response)";

      const usage = completion.usage;
      if (usage) {
        console.log(`LLM: response ${apiMs}ms (in=${usage.prompt_tokens}, out=${usage.completion_tokens}, total=${usage.total_tokens})`);
      } else {
        console.log(`LLM: response ${apiMs}ms`);
      }

      content = choice.message.content ? stripThinkBlocks(choice.message.content) || null : null;
      toolCalls = choice.message.tool_calls ?? undefined;
    }

    // If the model wants to call tools/agents
    if (toolCalls && toolCalls.length > 0) {
      // Collect tool names and results for flattened format
      const toolResults: { name: string; result: string }[] = [];

      for (const toolCall of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          console.warn(
            `LLM: invalid JSON in tool call args for ${toolCall.function.name}`,
          );
        }

        const isAgent = allowAgentDispatch && agentRegistryCache?.isAgent(toolCall.function.name);
        console.log(`LLM: calling ${isAgent ? "agent" : "tool"} "${toolCall.function.name}"`);

        // Dispatch: agent or tool?
        let result: string;
        if (isAgent) {
          result = await agentRegistryCache!.executeAgent(toolCall.function.name, args, channelId);
        } else {
          result = await executeTool(toolCall.function.name, args, channelId, userId);
        }

        toolResults.push({ name: toolCall.function.name, result });
      }

      // Track tool records for post-response verification
      for (const t of toolResults) {
        allToolRecords.push({
          name: t.name,
          result: t.result,
          failed: t.result.startsWith("Error:"),
        });
      }

      // Use flattened plain-text format instead of tool role messages
      // to avoid template errors with models like Qwen3 in LM Studio
      const names = toolResults.map((t) => t.name).join(", ");
      messages.push({
        role: "assistant",
        content: content || `[Used tools: ${names}]`,
      });
      const resultsText = toolResults
        .map((t) => {
          if (t.result.startsWith("Error:")) {
            return `[${t.name}]: TOOL FAILED - ${t.result}\nYou MUST report this failure to the user. Do NOT claim this action succeeded.`;
          }
          return `[${t.name}]: ${t.result}`;
        })
        .join("\n\n");
      messages.push({ role: "user", content: resultsText });

      continue;
    }

    // No tool calls — final text response (safety-net strip for any leaked reasoning)
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

    return finalText;
  }

  console.warn(`LLM: hit max tool iterations (${maxIterations})`);
  return "(reached maximum tool call depth)";
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
      // No tools — prevent further tool calls during correction
    });

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

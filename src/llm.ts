import OpenAI from "openai";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { Config } from "./config.js";
import {
  getToolDefinitionsForOpenAI,
  getEnabledTools,
  executeTool,
} from "./tool-registry.js";
import { getMemoryForPrompt } from "./memory.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type UserContent = string | ContentPart[];

/** Called for each text token during streaming. */
export type OnTokenCallback = (token: string) => void;

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
const MAX_SUMMARY_LENGTH = 3000;

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

// Queue of messages trimmed from history, keyed by channelId
const compactionQueue = new Map<string, ChatMessage[]>();

const MAX_TOOL_ITERATIONS = 10;

export function initLLM(cfg: Config): void {
  config = cfg;
  client = new OpenAI({
    baseURL: cfg.llm.baseURL,
    apiKey: cfg.llm.apiKey || undefined,
  });
  loadSummaries();
}

export function clearHistory(channelId: string): void {
  conversations.delete(channelId);
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

  const tools = getAllDefinitions();

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
  const tools = getAllDefinitions();

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

  // --- System state ---
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

  // --- Tool/agent inventory ---
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

  // --- Conversation summary (compacted history) ---
  if (channelId && summaries[channelId]) {
    sections.push(
      "\n\n## Recent Conversation Context\n" + summaries[channelId].summary,
    );
  }

  // --- Memory (per-user + per-channel facts) ---
  const memoryBlock = getMemoryForPrompt(userId ?? null, channelId ?? null);
  if (memoryBlock) sections.push("\n\n" + memoryBlock);

  if (sections.length === 0) return base;
  return base + sections.join("");
}

// --- Conversation compaction ---

/**
 * Compact pending trimmed history for channels that have accumulated enough messages.
 * Uses a direct LLM call (no tool dispatch) to avoid recursion.
 * Only fires the LLM call when a channel has >= minQueueSize queued messages.
 */
export async function compactPendingHistory(minQueueSize = 10): Promise<number> {
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
        return `${m.role}: ${text.slice(0, 300)}`;
      })
      .join("\n");

    if (!formatted) continue;

    try {
      const existing = summaries[channelId]?.summary ?? "";
      const contextNote = existing
        ? `Previous summary:\n${existing}\n\nNew messages to incorporate:\n`
        : "Messages to summarize:\n";

      const completion = await client.chat.completions.create({
        model: config.llm.model,
        max_completion_tokens: 500,
        messages: [
          {
            role: "system",
            content:
              "You are a conversation summarizer. Produce a concise summary of the conversation, " +
              "preserving key topics, decisions, and any important context. " +
              "Keep the summary under 2000 characters. Output ONLY the summary, no preamble.",
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
        console.log(`LLM: compacted ${messages.length} messages for channel ${channelId}`);
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
  maxIterations = MAX_TOOL_ITERATIONS,
  model?: string,
  allowAgentDispatch = true,
  onToken?: OnTokenCallback,
  userId?: string,
): Promise<string> {
  const baseParams = {
    model: model ?? config.llm.model,
    messages,
    max_completion_tokens: config.llm.maxTokens || undefined,
    ...(tools.length > 0 ? { tools } : {}),
  };

  for (let i = 0; i < maxIterations; i++) {
    let content: string | null;
    let toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined;

    if (onToken) {
      // --- Streaming path ---
      const stream = await client.chat.completions.create({ ...baseParams, stream: true });

      let contentAccum = "";
      const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          contentAccum += delta.content;
          onToken(delta.content);
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
      }

      content = contentAccum || null;

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
      // --- Non-streaming path (unchanged) ---
      const completion = await client.chat.completions.create(baseParams);
      const choice = completion.choices[0];
      if (!choice) return "(no response)";

      content = choice.message.content;
      toolCalls = choice.message.tool_calls ?? undefined;
    }

    // If the model wants to call tools/agents
    if (toolCalls && toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: content ?? null,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          console.warn(
            `LLM: invalid JSON in tool call args for ${toolCall.function.name}`,
          );
        }

        // Dispatch: agent or tool?
        let result: string;
        if (allowAgentDispatch && agentRegistryCache?.isAgent(toolCall.function.name)) {
          result = await agentRegistryCache.executeAgent(toolCall.function.name, args, channelId);
        } else {
          result = await executeTool(toolCall.function.name, args, channelId, userId);
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      continue;
    }

    // No tool calls — final text response
    return content?.trim() || "(no response)";
  }

  console.warn(`LLM: hit max tool iterations (${maxIterations})`);
  return "(reached maximum tool call depth)";
}

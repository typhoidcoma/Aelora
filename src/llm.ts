import OpenAI from "openai";
import type { Config } from "./config.js";
import {
  getToolDefinitionsForOpenAI,
  getEnabledTools,
  executeTool,
} from "./tool-registry.js";

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

const MAX_TOOL_ITERATIONS = 10;

export function initLLM(cfg: Config): void {
  config = cfg;
  client = new OpenAI({
    baseURL: cfg.llm.baseURL,
    apiKey: cfg.llm.apiKey || undefined,
  });
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

function trimHistory(history: ChatMessage[]): void {
  while (history.length > config.llm.maxHistory) {
    history.shift();
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
): Promise<string> {
  const history = getHistory(channelId);

  history.push({ role: "user", content: userMessage as string });
  trimHistory(history);

  const tools = getAllDefinitions();

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
  ];

  try {
    const result = await runCompletionLoop(messages, tools, channelId, undefined, undefined, true, onToken);

    history.push({ role: "assistant", content: result });
    trimHistory(history);

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
function buildSystemPrompt(): string {
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

  if (sections.length === 0) return base;
  return base + sections.join("");
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
          result = await executeTool(toolCall.function.name, args, channelId);
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
    return content ?? "(no response)";
  }

  console.warn(`LLM: hit max tool iterations (${maxIterations})`);
  return "(reached maximum tool call depth)";
}

import OpenAI from "openai";
import type { Config } from "./config.js";
import { getToolDefinitionsForOpenAI, executeTool } from "./tool-registry.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

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
 */
export async function getLLMResponse(
  channelId: string,
  userMessage: string,
): Promise<string> {
  const history = getHistory(channelId);

  history.push({ role: "user", content: userMessage });
  trimHistory(history);

  const tools = getAllDefinitions();

  const messages: ChatMessage[] = [
    { role: "system", content: config.llm.systemPrompt },
    ...history,
  ];

  try {
    const reply = await runCompletionLoop(messages, tools, channelId);

    history.push({ role: "assistant", content: reply });
    trimHistory(history);

    return reply;
  } catch (err) {
    // Remove the failed user message so history stays clean
    history.pop();
    throw err;
  }
}

/**
 * Stateless one-shot LLM call with tool/agent support (for cron, heartbeat, dashboard).
 */
export async function getLLMOneShot(prompt: string): Promise<string> {
  const tools = getAllDefinitions();

  const messages: ChatMessage[] = [
    { role: "system", content: config.llm.systemPrompt },
    { role: "user", content: prompt },
  ];

  return runCompletionLoop(messages, tools, null);
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
  return runCompletionLoop(messages, tools, channelId, max, model, false);
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
): Promise<string> {
  for (let i = 0; i < maxIterations; i++) {
    const completion = await client.chat.completions.create({
      model: model ?? config.llm.model,
      messages,
      max_tokens: config.llm.maxTokens || undefined,
      ...(tools.length > 0 ? { tools } : {}),
    });

    const choice = completion.choices[0];
    if (!choice) return "(no response)";

    const msg = choice.message;

    // If the model wants to call tools/agents
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });

      for (const toolCall of msg.tool_calls) {
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
    return msg.content ?? "(no response)";
  }

  console.warn(`LLM: hit max tool iterations (${maxIterations})`);
  return "(reached maximum tool call depth)";
}

import type OpenAI from "openai";
import {
  type NormalizedToolCall,
  type ProviderRuntime,
  type RuntimeTurnParams,
  type RuntimeTurnResult,
} from "../provider-types.js";

export class ChatCompletionsRuntime implements ProviderRuntime {
  readonly kind = "chat" as const;

  async runTurn(params: RuntimeTurnParams): Promise<RuntimeTurnResult> {
    const request = buildChatRequest(params);
    return params.stream
      ? runStreamingTurn(params.client, request, params.onTextDelta)
      : runNonStreamingTurn(params.client, request);
  }
}

function buildChatRequest(params: RuntimeTurnParams): OpenAI.Chat.Completions.ChatCompletionCreateParams {
  const TOKEN_FLOOR_WITH_TOOLS = 16384;
  const base: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    ...(params.tools.length > 0
      ? {
          tools: params.tools,
          max_completion_tokens: Math.max(
            params.maxOutputTokens || TOKEN_FLOOR_WITH_TOOLS,
            TOKEN_FLOOR_WITH_TOOLS,
          ),
        }
      : params.maxOutputTokens
        ? { max_completion_tokens: params.maxOutputTokens }
        : {}),
  };
  // Prompt cache key — OpenAI + Anthropic OpenAI-compat endpoints read this to
  // boost prefix-cache hit rate. Unknown providers ignore it.
  if (params.promptCacheKey) base.prompt_cache_key = params.promptCacheKey;
  if (params.userId) base.user = params.userId;
  return base as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams;
}

async function runStreamingTurn(
  client: OpenAI,
  request: OpenAI.Chat.Completions.ChatCompletionCreateParams,
  onTextDelta?: (delta: string) => void,
): Promise<RuntimeTurnResult> {
  const stream = (await client.chat.completions.create({
    ...request,
    stream: true,
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming)) as AsyncIterable<unknown>;

  let content = "";
  let usage: RuntimeTurnResult["usage"];
  const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunkRaw of stream) {
    const chunk = chunkRaw as {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
        cache_read_input_tokens?: number;
      };
    };

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      onTextDelta?.(delta.content);
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

    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
        cachedTokens:
          chunk.usage.prompt_tokens_details?.cached_tokens ??
          chunk.usage.cache_read_input_tokens ??
          0,
      };
    }
  }

  return {
    content: content || null,
    toolCalls: normalizeToolCalls(toolCallAccum),
    usage,
  };
}

async function runNonStreamingTurn(
  client: OpenAI,
  request: OpenAI.Chat.Completions.ChatCompletionCreateParams,
): Promise<RuntimeTurnResult> {
  const completion = await client.chat.completions.create(
    request as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  );
  const choice = completion.choices[0];

  const rawUsage = completion.usage as
    | (OpenAI.CompletionUsage & {
        prompt_tokens_details?: { cached_tokens?: number };
        cache_read_input_tokens?: number;
      })
    | undefined;

  return {
    content: choice?.message.content ?? null,
    toolCalls: normalizeChatToolCalls(choice?.message.tool_calls),
    usage: rawUsage
      ? {
          inputTokens: rawUsage.prompt_tokens,
          outputTokens: rawUsage.completion_tokens,
          totalTokens: rawUsage.total_tokens,
          cachedTokens:
            rawUsage.prompt_tokens_details?.cached_tokens ??
            rawUsage.cache_read_input_tokens ??
            0,
        }
      : undefined,
  };
}

function normalizeToolCalls(
  toolCallAccum: Map<number, { id: string; name: string; arguments: string }>,
): NormalizedToolCall[] | undefined {
  if (toolCallAccum.size === 0) return undefined;
  return [...toolCallAccum.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id || `${tc.name}-call`,
      name: tc.name,
      arguments: tc.arguments,
    }));
}

function normalizeChatToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): NormalizedToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));
}

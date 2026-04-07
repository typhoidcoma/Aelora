import type OpenAI from "openai";
import type {
  EasyInputMessage,
  FunctionTool,
  Response,
  ResponseInput,
  ResponseInputMessageContentList,
  ResponseInputText,
  ResponseInputImage,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  type NormalizedToolCall,
  type ProviderRuntime,
  type RuntimeTurnParams,
  type RuntimeTurnResult,
} from "../provider-types.js";

export class ResponsesRuntime implements ProviderRuntime {
  readonly kind = "responses" as const;

  async runTurn(params: RuntimeTurnParams): Promise<RuntimeTurnResult> {
    const instructions = extractSystemInstructions(params.messages);
    const input = messagesToResponsesInput(params.messages);
    const tools = mapChatToolsToResponsesTools(params.tools);

    const request: ResponsesRequest = {
      model: params.model,
      instructions: instructions || undefined,
      input,
      ...(params.maxOutputTokens ? { max_output_tokens: params.maxOutputTokens } : {}),
      ...(tools.length > 0 ? { tools, parallel_tool_calls: true } : {}),
      ...(params.userId ? { user: params.userId } : {}),
      ...(params.continuation?.previousResponseId
        ? { previous_response_id: params.continuation.previousResponseId }
        : {}),
      store: false as const,
      truncation: "disabled" as const,
    };

    return params.stream
      ? runStreamingTurn(params.client, request, params.onTextDelta)
      : runNonStreamingTurn(params.client, request);
  }
}

type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: string | ResponseInput;
  max_output_tokens?: number;
  tools?: FunctionTool[];
  parallel_tool_calls?: boolean;
  user?: string;
  previous_response_id?: string;
  store: false;
  truncation: "disabled";
};

function extractSystemInstructions(messages: RuntimeTurnParams["messages"]): string {
  const first = messages[0];
  if (!first || first.role !== "system") return "";
  if (typeof first.content === "string") return first.content;
  return flattenContentParts(first.content);
}

export function messagesToResponsesInput(messages: RuntimeTurnParams["messages"]): ResponseInput {
  return messages
    .slice(messages[0]?.role === "system" ? 1 : 0)
    .map((message) => ({
      role: message.role as EasyInputMessage["role"],
      content:
        typeof message.content === "string"
          ? message.content
          : mapContentParts(message.content),
    }));
}

export function mapChatToolsToResponsesTools(
  tools: RuntimeTurnParams["tools"],
): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: (tool.function.parameters as Record<string, unknown>) ?? null,
    strict: true,
  }));
}

async function runNonStreamingTurn(
  client: OpenAI,
  request: ResponsesRequest,
): Promise<RuntimeTurnResult> {
  const response = await client.responses.create(request);
  const finalized = response as Response;

  return {
    content: finalized.output_text || null,
    toolCalls: normalizeResponseToolCalls(finalized.output),
    continuation: finalized.id ? { previousResponseId: finalized.id } : undefined,
    usage: finalized.usage
      ? {
          inputTokens: finalized.usage.input_tokens,
          outputTokens: finalized.usage.output_tokens,
          totalTokens: finalized.usage.total_tokens,
          reasoningTokens: finalized.usage.output_tokens_details.reasoning_tokens,
        }
      : undefined,
  };
}

async function runStreamingTurn(
  client: OpenAI,
  request: ResponsesRequest,
  onTextDelta?: (delta: string) => void,
): Promise<RuntimeTurnResult> {
  const stream = (await client.responses.create({
    ...request,
    stream: true,
  })) as AsyncIterable<ResponseStreamEvent>;

  let content = "";
  let completedResponse: Response | null = null;
  const toolCallsByItem = new Map<string, Partial<NormalizedToolCall> & { providerCallId?: string }>();

  for await (const event of stream) {
    switch (event.type) {
      case "response.output_text.delta":
        content += event.delta;
        onTextDelta?.(event.delta);
        break;
      case "response.function_call_arguments.done": {
        const existing = toolCallsByItem.get(event.item_id) ?? { id: event.item_id };
        existing.arguments = event.arguments;
        toolCallsByItem.set(event.item_id, existing);
        break;
      }
      case "response.output_item.done":
        if (event.item.type === "function_call") {
          const existing = toolCallsByItem.get(event.item.id ?? event.item.call_id) ?? {
            id: event.item.id ?? event.item.call_id,
          };
          existing.id = event.item.id ?? event.item.call_id;
          existing.providerCallId = event.item.call_id;
          existing.name = event.item.name;
          existing.arguments = event.item.arguments;
          toolCallsByItem.set(event.item.id ?? event.item.call_id, existing);
        }
        break;
      case "response.completed":
        completedResponse = event.response;
        if (!content && event.response.output_text) {
          content = event.response.output_text;
        }
        break;
    }
  }

  return {
    content: content || completedResponse?.output_text || null,
    toolCalls: finalizeStreamToolCalls(toolCallsByItem),
    continuation: completedResponse?.id ? { previousResponseId: completedResponse.id } : undefined,
    usage: completedResponse?.usage
      ? {
          inputTokens: completedResponse.usage.input_tokens,
          outputTokens: completedResponse.usage.output_tokens,
          totalTokens: completedResponse.usage.total_tokens,
          reasoningTokens: completedResponse.usage.output_tokens_details.reasoning_tokens,
        }
      : undefined,
  };
}

function finalizeStreamToolCalls(
  toolCallsByItem: Map<string, Partial<NormalizedToolCall> & { providerCallId?: string }>,
): NormalizedToolCall[] | undefined {
  if (toolCallsByItem.size === 0) return undefined;
  return [...toolCallsByItem.values()]
    .filter((tc): tc is NormalizedToolCall & { providerCallId?: string } =>
      typeof tc.id === "string" &&
      typeof tc.name === "string" &&
      typeof tc.arguments === "string",
    )
    .map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      providerCallId: tc.providerCallId,
    }));
}

function normalizeResponseToolCalls(output: ResponseOutputItem[]): NormalizedToolCall[] | undefined {
  const calls = output
    .filter((item): item is Extract<ResponseOutputItem, { type: "function_call" }> => item.type === "function_call")
    .map((item) => ({
      id: item.id ?? item.call_id,
      name: item.name,
      arguments: item.arguments,
      providerCallId: item.call_id,
    }));

  return calls.length > 0 ? calls : undefined;
}

function mapContentParts(content: unknown): ResponseInputMessageContentList {
  if (!Array.isArray(content)) {
    return [{ type: "input_text", text: String(content ?? "") }];
  }

  const parts: Array<ResponseInputText | ResponseInputImage> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typed = part as {
      type?: string;
      text?: string;
      image_url?: string | { url?: string };
    };

    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push({ type: "input_text", text: typed.text });
      continue;
    }

    if (typed.type === "image_url") {
      const imageUrl = typeof typed.image_url === "string"
        ? typed.image_url
        : typed.image_url?.url;
      if (imageUrl) {
        parts.push({ type: "input_image", image_url: imageUrl, detail: "auto" });
      }
    }
  }

  return parts.length > 0
    ? parts
    : [{ type: "input_text", text: flattenContentParts(content) }];
}

function flattenContentParts(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part) {
        return typeof part.text === "string" ? part.text : "";
      }
      if (part && typeof part === "object" && "type" in part) {
        return `[${String((part as { type?: string }).type ?? "content")}]`;
      }
      return "";
    })
    .join(" ")
    .trim();
}

import type OpenAI from "openai";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type NormalizedToolCall = {
  id: string;
  name: string;
  arguments: string;
  providerCallId?: string;
};

export type RuntimeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
};

export type RuntimeContinuation = {
  previousResponseId?: string;
};

export type RuntimeTurnParams = {
  client: OpenAI;
  model: string;
  messages: ChatMessage[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  maxOutputTokens?: number;
  stream: boolean;
  userId?: string;
  continuation?: RuntimeContinuation;
  onTextDelta?: (delta: string) => void;
};

export type RuntimeTurnResult = {
  content: string | null;
  toolCalls?: NormalizedToolCall[];
  continuation?: RuntimeContinuation;
  usage?: RuntimeUsage;
};

export interface ProviderRuntime {
  readonly kind: "responses" | "chat";
  runTurn(params: RuntimeTurnParams): Promise<RuntimeTurnResult>;
}

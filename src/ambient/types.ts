import type { Config } from "../config.js";
import type { ChannelBuffer } from "./buffer.js";
import type OpenAI from "openai";

export type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

export type TriggerResult = {
  /** The message text to send. Null/empty = skip. */
  message: string | null;
  /** Optional: reply to a specific message instead of standalone. */
  replyToMessageId?: string;
  /** Delay in ms before sending (natural feel). */
  delayMs?: number;
  /** Debug info for dashboard/logging. */
  debugReason?: string;
};

export type TriggerContext = {
  buffer: ChannelBuffer;
  config: Config;
  botUserId: string;
  /** Lightweight LLM call for trigger evaluation (uses auxiliary model, no tools). Accepts plain text or multimodal content. */
  llmEvaluate: (prompt: string | ContentPart[]) => Promise<string>;
  /** Get all buffers (for cross-channel awareness). */
  getAllBuffers: () => ChannelBuffer[];
};

export type AmbientTrigger = {
  name: string;
  description: string;
  /**
   * Quick pre-filter: should this trigger even be evaluated?
   * Runs WITHOUT an LLM call. Return false to skip cheaply.
   */
  shouldEvaluate: (buffer: ChannelBuffer, config: Config) => boolean;
  /**
   * Full evaluation: analyze the buffer and decide whether to fire.
   * May call the LLM. Return null message to skip.
   */
  evaluate: (ctx: TriggerContext) => Promise<TriggerResult>;
};

import type { Config } from "../config.js";
import { ChatCompletionsRuntime } from "./runtimes/chat-completions.js";
import { ResponsesRuntime } from "./runtimes/responses.js";
import type { ProviderRuntime } from "./provider-types.js";

const RESPONSES_RUNTIME = new ResponsesRuntime();
const CHAT_RUNTIME = new ChatCompletionsRuntime();

function baseUrlSupportsResponses(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === "api.openai.com";
  } catch {
    return false;
  }
}

export function getConfiguredLLMRuntimeKind(config: Config): ProviderRuntime["kind"] {
  if (config.llm.runtime === "chat") return "chat";

  const supportsResponses =
    config.llm.supportsResponses ?? baseUrlSupportsResponses(config.llm.baseURL);

  if (config.llm.runtime === "responses") {
    if (!supportsResponses) {
      throw new Error(
        "LLM runtime is set to responses, but the configured baseURL is not marked as Responses-capable. " +
        "Use llm.runtime: chat, point to api.openai.com, or set llm.supportsResponses: true if you know the endpoint supports it.",
      );
    }
    return "responses";
  }

  return supportsResponses ? "responses" : "chat";
}

export function selectProviderRuntime(config: Config): ProviderRuntime {
  return getConfiguredLLMRuntimeKind(config) === "responses"
    ? RESPONSES_RUNTIME
    : CHAT_RUNTIME;
}

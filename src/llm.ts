import OpenAI from "openai";
import type { Config } from "./config.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

let client: OpenAI;
let config: Config;

// Per-channel conversation history
const conversations = new Map<string, ChatMessage[]>();

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
 * Get an LLM response with per-channel conversation memory.
 */
export async function getLLMResponse(
  channelId: string,
  userMessage: string,
): Promise<string> {
  const history = getHistory(channelId);

  history.push({ role: "user", content: userMessage });
  trimHistory(history);

  const messages: ChatMessage[] = [
    { role: "system", content: config.llm.systemPrompt },
    ...history,
  ];

  try {
    const completion = await client.chat.completions.create({
      model: config.llm.model,
      messages,
      max_tokens: config.llm.maxTokens || undefined,
    });

    const reply = completion.choices[0]?.message?.content ?? "(no response)";

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
 * Stateless one-shot LLM call (for cron jobs).
 */
export async function getLLMOneShot(prompt: string): Promise<string> {
  const completion = await client.chat.completions.create({
    model: config.llm.model,
    messages: [
      { role: "system", content: config.llm.systemPrompt },
      { role: "user", content: prompt },
    ],
    max_tokens: config.llm.maxTokens || undefined,
  });

  return completion.choices[0]?.message?.content ?? "(no response)";
}

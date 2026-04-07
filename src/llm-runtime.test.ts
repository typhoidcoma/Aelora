import OpenAI from "openai";
import { getConfiguredLLMRuntimeKind } from "./llm/runtime-selector.js";
import { messagesToResponsesInput, mapChatToolsToResponsesTools } from "./llm/runtimes/responses.js";
import type { Config } from "./config.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, actual?: unknown): void {
  if (condition) {
    console.log(`  OK ${message}`);
    passed++;
  } else {
    console.error(`  FAIL ${message}${actual !== undefined ? ` (got: ${JSON.stringify(actual)})` : ""}`);
    failed++;
  }
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

function makeConfig(overrides?: Partial<Config["llm"]>): Config {
  return {
    timezone: "UTC",
    discord: {
      token: "test-token",
      guildMode: "mention",
      allowedChannels: [],
      allowDMs: true,
      status: "Testing",
    },
    llm: {
      baseURL: "http://localhost:1234/v1",
      apiKey: "test-key",
      model: "test-model",
      auxiliaryModel: "aux-model",
      runtime: "auto",
      supportsResponses: false,
      systemPrompt: "BASE PROMPT",
      ambientSystemPrompt: "",
      maxTokens: 4096,
      maxHistory: 50,
      maxToolIterations: 25,
      lite: false,
      disableThinking: false,
      verifyToolClaims: false,
      maxVerificationRetries: 1,
      ...overrides,
    },
    web: {
      enabled: false,
      port: 3000,
      basePath: "",
      auth: {
        allowQueryToken: true,
        allowWsQueryToken: true,
      },
    },
    persona: {
      enabled: true,
      dir: "persona",
      botName: "Aelora",
      activePersona: "aelora",
    },
    heartbeat: {
      enabled: false,
      intervalMs: 900_000,
    },
    agents: {
      enabled: false,
      maxIterations: 5,
    },
    tools: {},
    activity: {
      enabled: false,
      clientId: "",
      clientSecret: "",
      serverUrl: "",
    },
    memory: {
      maxFactsPerScope: 100,
      maxFactLength: 1000,
      maxAgeDays: 0,
      autoExtract: true,
      vectorSearch: false,
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      embeddingBaseURL: "http://localhost:1234/v1",
      embeddingApiKey: "",
      semanticDedupThreshold: 0.85,
      semanticSearchTopK: 10,
      semanticSearchMinScore: 0.3,
      consolidationEnabled: true,
      consolidationThreshold: 10,
    },
    logger: {
      maxBuffer: 200,
      fileEnabled: false,
      retainDays: 7,
    },
    cron: {
      maxHistory: 10,
    },
    knowledge: {
      enabled: false,
      driveFolderId: "",
      syncIntervalMinutes: 30,
      chunkSize: 800,
      chunkOverlap: 100,
      maxChunksPerPrompt: 5,
      minRelevanceScore: 0.35,
    },
    ambient: {
      enabled: false,
      bufferSize: 100,
      evaluationIntervalMs: 300_000,
      globalRateLimitPerHour: 6,
      channelCooldownMinutes: 15,
      minBufferMessages: 3,
      triggers: {
        converse: {
          enabled: true,
          cooldownMinutes: 30,
          skipChance: 0.3,
          minMessages: 4,
          minUsers: 2,
          windowMinutes: 30,
        },
        imageReact: {
          enabled: true,
          cooldownMinutes: 30,
          skipChance: 0.25,
          minMessages: 3,
          minAgeMinutes: 3,
          maxAgeMinutes: 45,
        },
      },
    },
    supabase: undefined,
  };
}

function main(): void {
  section("Runtime Selection");
  assert(getConfiguredLLMRuntimeKind(makeConfig()) === "chat", "auto selects chat for non-OpenAI-compatible baseURL");
  assert(
    getConfiguredLLMRuntimeKind(makeConfig({ baseURL: "https://api.openai.com/v1", supportsResponses: undefined })) === "responses",
    "auto selects responses for OpenAI baseURL",
  );
  assert(
    getConfiguredLLMRuntimeKind(makeConfig({ runtime: "chat", baseURL: "https://api.openai.com/v1" })) === "chat",
    "explicit chat overrides auto detection",
  );
  assert(
    getConfiguredLLMRuntimeKind(makeConfig({ runtime: "responses", supportsResponses: true })) === "responses",
    "explicit responses works with support override",
  );

  let threw = false;
  try {
    getConfiguredLLMRuntimeKind(makeConfig({ runtime: "responses", supportsResponses: false }));
  } catch {
    threw = true;
  }
  assert(threw, "explicit responses rejects unsupported endpoint");

  section("Responses Input Mapping");
  const input = messagesToResponsesInput([
    { role: "system", content: "system prompt" },
    {
      role: "user",
      content: [
        { type: "text", text: "caption" },
        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
      ] as OpenAI.Chat.Completions.ChatCompletionContentPart[],
    },
    { role: "assistant", content: "done" },
  ]);

  assert(Array.isArray(input) && input.length === 2, "responses input drops leading system message into instructions path", input);
  const multimodal = input[0] as { content: Array<{ type: string; text?: string; image_url?: string }> };
  assert(multimodal.content[0].type === "input_text", "responses input maps text content parts");
  assert(multimodal.content[1].type === "input_image", "responses input maps image content parts");

  section("Tool Mapping");
  const tools = mapChatToolsToResponsesTools([
    {
      type: "function",
      function: {
        name: "memory",
        description: "Save or search memory facts.",
        parameters: { type: "object", properties: { action: { type: "string" } } },
      },
    },
  ]);

  assert(tools.length === 1, "responses tool mapping preserves tool count");
  assert(tools[0].name === "memory", "responses tool mapping preserves tool name");
  assert(tools[0].strict === true, "responses tool mapping enables strict validation");

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }

  console.log(`\n${passed} tests passed.`);
}

main();

import { loadPersona, composeAmbientPrompt } from "./persona.js";
import { initLLM, buildSystemPrompt, renderToolRoundMessages } from "./llm.js";
import { resolveAmbientPersonaContext } from "./ambient/engine.js";
import { updateUser } from "./users.js";
import { recordMessage } from "./sessions.js";
import { saveFact } from "./memory.js";
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
      http2Enabled: false,
      promptCacheEnabled: false,
      providerHint: "auto",
      promptCacheScope: "persona+channel",
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
      wsCompression: false,
      wsBinaryEmotion: false,
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
      triageEnabled: true,
      triageCooldownMs: 30000,
      temporalExpiryEnabled: true,
      profileEnabled: true,
      profileMaxChars: 7000,
      profileMinFacts: 3,
      profileRebuildThreshold: 2,
      profileRebuildDebounceMs: 5000,
    },
    logger: {
      maxBuffer: 200,
      fileEnabled: false,
      retainDays: 7,
      logAllRequests: false,
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

async function main(): Promise<void> {
  section("Ambient Persona Composition");
  const persona = loadPersona("persona", { botName: "Aelora" }, "aelora");
  const ambientPrompt = composeAmbientPrompt(persona);
  assert(ambientPrompt.includes("# Operating Instructions"), "ambient prompt includes bootstrap");
  assert(ambientPrompt.includes("Growth over engagement"), "ambient prompt includes shared lore");
  assert(ambientPrompt.includes("# Soul: Aelora"), "ambient prompt includes soul");
  assert(!ambientPrompt.includes("# Tools & Agents"), "ambient prompt excludes tools instructions");
  assert(!ambientPrompt.includes("# Skills"), "ambient prompt excludes disabled skills layer");
  assert(persona.composedPrompt.length < 30000, "trimmed persona prompt is materially smaller than previous baseline", persona.composedPrompt.length);
  assert(ambientPrompt.length <= persona.composedPrompt.length, "ambient prompt does not exceed full prompt");

  section("System Prompt Composition");
  const uniqueId = `persona-llm-test-${Date.now()}`;
  const channelId = `channel-${uniqueId}`;
  const userId = `user-${uniqueId}`;
  const uniqueFact = `Prefers architecture audits with explicit runtime checks ${uniqueId}`;

  updateUser(userId, "Test User", channelId);
  recordMessage({
    channelId,
    guildId: null,
    channelName: "test-room",
    userId,
    username: "Test User",
  });
  saveFact(`user:${userId}`, uniqueFact, {
    category: "preference",
    confidence: "stated",
    source: "test",
  });

  initLLM(makeConfig({ systemPrompt: persona.composedPrompt, ambientSystemPrompt: ambientPrompt }));
  const prompt = await buildSystemPrompt(userId, channelId, "architecture persona prompt flow");
  assert(prompt.startsWith("# Operating Instructions"), "system prompt starts with trimmed persona bootstrap");
  assert(prompt.includes("## Current Mood"), "system prompt includes mood section");
  assert(prompt.includes("## Current User"), "system prompt includes current user section");
  assert(prompt.includes("## Current Session"), "system prompt includes current session section");
  assert(prompt.includes("## Memory"), "system prompt includes memory section");
  assert(prompt.includes(uniqueFact), "system prompt includes relevant memory fact");
  assert(prompt.includes("## Current Date & Time"), "system prompt includes current date/time section");
  assert(prompt.includes("Growth over engagement"), "system prompt includes trimmed lore values");
  assert(prompt.includes("Warm, direct, capable"), "system prompt includes Aelora voice core");
  assert(prompt.includes("Use tool calls for real actions."), "system prompt retains tool integrity guidance");
  assert(!prompt.includes("# Tools & Agents"), "system prompt excludes disabled tools persona layer");
  assert(!prompt.includes("# Shared Tool Instructions"), "system prompt excludes disabled shared tools layer");
  assert(!prompt.includes("# Skills"), "system prompt excludes disabled skills layer");

  section("Lite Mode Prompt");
  initLLM(makeConfig({ lite: true, systemPrompt: "LITE BASE PROMPT" }));
  const litePrompt = await buildSystemPrompt(userId, channelId, "architecture persona prompt flow");
  assert(litePrompt.startsWith("LITE BASE PROMPT"), "lite prompt starts with lite base prompt");
  assert(litePrompt.includes("## Current Mood"), "lite mode still includes mood");
  assert(litePrompt.includes("## Current User"), "lite mode still includes user section");
  assert(litePrompt.includes("## Current Session"), "lite mode still includes session section");
  assert(litePrompt.includes("## Memory"), "lite mode still includes memory");
  assert(litePrompt.includes("## Current Date & Time"), "lite mode still includes date/time");

  section("Tool Round Rendering");
  const rendered = renderToolRoundMessages(
    [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "calendar",
          arguments: "{\"title\":\"Standup\",\"when\":\"tomorrow\"}",
        },
      },
    ],
    [{ name: "calendar", result: "Created event successfully." }],
    "Checking the calendar",
  );
  assert(rendered.assistantContent.includes("Checking the calendar"), "tool render preserves assistant preface");
  assert(rendered.assistantContent.includes("<tool_call>"), "tool render emits tool_call wrapper");
  assert(rendered.assistantContent.includes("<function=calendar>"), "tool render emits function name");
  assert(rendered.assistantContent.includes("<parameter=title>"), "tool render emits parameter tags");
  assert(rendered.userContent.includes("<tool_response>"), "tool render emits tool_response wrapper");
  assert(rendered.userContent.includes("Created event successfully."), "tool render includes tool result");

  const renderedError = renderToolRoundMessages(
    [
      {
        id: "call_2",
        type: "function",
        function: {
          name: "linear",
          arguments: "{\"action\":\"create_issue\"}",
        },
      },
    ],
    [{ name: "linear", result: "Error: Linear API unavailable" }],
  );
  assert(renderedError.userContent.includes("TOOL FAILED - Error: Linear API unavailable"), "tool render marks failed tool calls explicitly");

  section("Ambient Fallback");
  const ambientConfig = makeConfig({
    systemPrompt: "FULL PERSONA",
    ambientSystemPrompt: "AMBIENT PERSONA",
  });
  assert(resolveAmbientPersonaContext(ambientConfig) === "AMBIENT PERSONA", "ambient context prefers ambientSystemPrompt");
  ambientConfig.llm.ambientSystemPrompt = "";
  assert(resolveAmbientPersonaContext(ambientConfig) === "FULL PERSONA", "ambient context falls back to systemPrompt");

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }

  console.log(`\n${passed} tests passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("persona-llm.test.ts failed:", err);
  process.exit(1);
});

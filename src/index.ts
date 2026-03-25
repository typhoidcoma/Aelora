import { installLogger } from "./logger.js";
import { loadConfig } from "./config.js";
import { loadPersona, substituteVariables, type PersonaState } from "./persona.js";
import { initLLM, getLLMOneShot, setSystemStateProvider, saveConversations } from "./llm.js";
import { loadTools } from "./tool-registry.js";
import { loadAgents } from "./agent-registry.js";
import { enableAgentDispatch } from "./llm.js";
import { setToolConfigStore } from "./tools/types.js";
import { startDiscord, sendToChannel, discordClient } from "./discord.js";
import { startCron, stopCron, getCronJobs, configureCron } from "./cron.js";
import { startHeartbeat, stopHeartbeat, getHeartbeatState } from "./heartbeat.js";
import { registerCalendarReminder } from "./heartbeat-calendar.js";
import { registerMemoryCompaction } from "./heartbeat-memory.js";
import { registerDataCleanup } from "./heartbeat-cleanup.js";
import { registerReplyCheck } from "./heartbeat-reply-check.js";
import { registerLastAlive } from "./heartbeat-alive.js";
import { registerConversationSave } from "./heartbeat-conversations.js";
import { registerScoringSync } from "./heartbeat-scoring-sync.js";
import { registerConsolidation, configureConsolidation } from "./heartbeat-consolidation.js";
import { registerKnowledgeSync } from "./heartbeat-knowledge-sync.js";
import { startWeb, type AppState } from "./web.js";
import { startWebSocket } from "./ws.js";
import { saveState, consumePreviousState, loadActivePersona } from "./state.js";
import { configureMemory } from "./memory.js";
import { configureLogger } from "./logger.js";
import { appendSystemEvent } from "./daily-log.js";
import { tryGetSupabaseClient } from "./supabase.js";
import { flushAllQueuedWrites } from "./async-write-queue.js";

// Install logger first so all console output is captured
installLogger();

async function main(): Promise<void> {
  const bootStart = Date.now();
  console.log("Aelora 🦋 starting...\n");

  // 1. Load config
  const config = loadConfig();
  process.env.TZ = config.timezone;
  setToolConfigStore(config.tools);
  configureLogger(config.logger);
  await configureMemory({
    maxFactsPerScope: config.memory.maxFactsPerScope,
    maxFactLength: config.memory.maxFactLength,
    vector: {
      enabled: config.memory.vectorSearch,
      apiKey: config.memory.embeddingApiKey || config.llm.apiKey,
      baseURL: config.memory.embeddingBaseURL,
      model: config.memory.embeddingModel,
      dimensions: config.memory.embeddingDimensions,
      dedupThreshold: config.memory.semanticDedupThreshold,
      searchTopK: config.memory.semanticSearchTopK,
      searchMinScore: config.memory.semanticSearchMinScore,
    },
  });
  configureCron({ ...config.cron, defaultTimezone: config.timezone });
  console.log(`Config: model=${config.llm.model}, mode=${config.discord.guildMode}, tz=${config.timezone}`);

  // 2. Load persona (compose system prompt from persona/ directory)
  //    Use persisted active persona if available (survives crashes/restarts)
  const savedPersona = loadActivePersona();
  if (savedPersona && savedPersona !== config.persona.activePersona) {
    console.log(`Persona: restoring last active persona "${savedPersona}" (config default: "${config.persona.activePersona}")`);
    config.persona.activePersona = savedPersona;
  }

  let personaState: PersonaState | null = null;
  if (config.persona.enabled) {
    try {
      personaState = loadPersona(config.persona.dir, { botName: config.persona.botName }, config.persona.activePersona);
      config.llm.systemPrompt = personaState.composedPrompt;

      // Compose ambient-specific prompt: voice-relevant sections only (no tools/skills)
      const ambientSections = new Set(["bootstrap", "lore", "soul"]);
      config.llm.ambientSystemPrompt = personaState.files
        .filter((f) => f.meta.enabled && ambientSections.has(f.meta.section))
        .map((f) => substituteVariables(f.rawContent, { botName: personaState!.botName }))
        .join("\n\n");
    } catch (err) {
      console.error(`Persona: failed to load "${config.persona.activePersona}":`, err);
      console.warn("Persona: continuing without persona system");
    }
  }

  // 3. Initialize LLM client
  console.log(`LLM: ${config.llm.baseURL} / ${config.llm.model}`);
  initLLM(config);

  // 3b. Initialize Supabase client (if configured)
  const sb = tryGetSupabaseClient(config);
  if (sb) console.log("Supabase: connected");
  else if (config.supabase) console.warn("Supabase: configured but failed to connect");

  // 4. Load tools
  await loadTools();

  // 5. Load agents
  if (config.agents.enabled) {
    await loadAgents();
    const agentRegistry = await import("./agent-registry.js");
    enableAgentDispatch(agentRegistry);
  }

  // 6. Connect to Discord
  console.log("Discord: connecting...");
  await startDiscord(config);

  // 7. Check previous state (log only  -  no Discord message on startup)
  const prevState = consumePreviousState();
  appendSystemEvent("startup", prevState ? `Restarted (${prevState.reason})` : "Cold start");

  // 8. Start cron scheduler
  startCron();

  // 9. Start heartbeat
  if (config.heartbeat.enabled) {
    registerCalendarReminder();
    registerMemoryCompaction();
    registerDataCleanup();
    registerReplyCheck();
    registerLastAlive();
    registerConversationSave();
    registerScoringSync();
    configureConsolidation({
      enabled: config.memory.consolidationEnabled,
      threshold: config.memory.consolidationThreshold,
    });
    registerConsolidation();
    // Knowledge base sync (Google Drive → vector index)
    if (config.knowledge.enabled && config.knowledge.driveFolderId) {
      const google = config.tools?.google as
        | { clientId?: string; clientSecret?: string; refreshToken?: string }
        | undefined;
      if (google?.clientId && google?.refreshToken) {
        registerKnowledgeSync(config.knowledge, {
          clientId: google.clientId,
          clientSecret: google.clientSecret ?? "",
          refreshToken: google.refreshToken,
        });
      } else {
        console.warn("KnowledgeBase: enabled but Google credentials not configured");
      }
    }
    // Ambient awareness system
    if (config.ambient.enabled) {
      const { configureBuffer } = await import("./ambient/buffer.js");
      const { registerAmbientEngine } = await import("./ambient/engine.js");
      configureBuffer({ bufferSize: config.ambient.bufferSize });
      registerAmbientEngine(config, sendToChannel);
    }

    startHeartbeat(config, {
      sendToChannel,
      llmOneShot: getLLMOneShot,
      config,
    });
  }

  // 10. Start web dashboard + WebSocket
  const appState: AppState = { config, personaState };
  const server = startWeb(appState);
  if (server) startWebSocket(server, config);

  // 11. Register live system state for LLM context
  setSystemStateProvider(() => {
    const hb = config.heartbeat.enabled ? getHeartbeatState() : null;
    return {
      botName: appState.personaState?.botName ?? config.persona.botName,
      discordTag: discordClient?.user?.tag ?? null,
      connected: discordClient?.isReady() ?? false,
      guildCount: discordClient?.guilds.cache.size ?? 0,
      uptime: process.uptime(),
      model: config.llm.model,
      heartbeat: hb ? { running: hb.running, handlers: hb.handlers.length } : null,
      cronJobs: getCronJobs().map((j) => ({
        name: j.name,
        enabled: j.enabled,
        nextRun: j.nextRun,
      })),
    };
  });

  console.log(`\nAelora 🦋 is ready (boot: ${Date.now() - bootStart}ms)\n`);
}

let isShuttingDown = false;

function shutdown(reason: "clean" | "crash" | "fatal", code: number, error?: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  saveConversations();
  saveState(reason, error);
  stopHeartbeat();
  stopCron();

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  void Promise.race([flushAllQueuedWrites(), timeout]).finally(() => {
    process.exit(code);
  });
}

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  shutdown("clean", 0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  shutdown("clean", 0);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  shutdown("crash", 1, err?.stack ?? String(err));
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  shutdown("crash", 1, reason instanceof Error ? (reason.stack ?? String(reason)) : String(reason));
});

main().catch((err) => {
  console.error("Fatal error:", err);
  shutdown("fatal", 1, err?.stack ?? String(err));
});

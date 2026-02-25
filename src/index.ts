import { installLogger } from "./logger.js";
import { loadConfig } from "./config.js";
import { loadPersona, type PersonaState } from "./persona.js";
import { initLLM, getLLMOneShot, setSystemStateProvider } from "./llm.js";
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
import { startWeb, type AppState } from "./web.js";
import { startWebSocket } from "./ws.js";
import { saveState, consumePreviousState, formatRestartMessage, loadActivePersona } from "./state.js";
import { configureMemory } from "./memory.js";
import { configureLogger } from "./logger.js";
import { appendSystemEvent } from "./daily-log.js";

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
  configureMemory(config.memory);
  configureCron(config.cron);
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
    } catch (err) {
      console.error(`Persona: failed to load "${config.persona.activePersona}":`, err);
      console.warn("Persona: continuing without persona system");
    }
  }

  // 3. Initialize LLM client
  console.log(`LLM: ${config.llm.baseURL} / ${config.llm.model}`);
  initLLM(config);

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

  // 7. Check previous state and send restart notification
  const prevState = consumePreviousState();
  if (prevState && config.discord.statusChannelId) {
    try {
      const msg = formatRestartMessage(prevState);
      await sendToChannel(config.discord.statusChannelId, msg);
    } catch (err) {
      console.error("Failed to send restart notification:", err);
    }
  }
  appendSystemEvent("startup", prevState ? `Restarted (${prevState.reason})` : "Cold start");

  // 8. Start cron scheduler
  startCron();

  // 9. Start heartbeat
  if (config.heartbeat.enabled) {
    registerCalendarReminder();
    registerMemoryCompaction();
    registerDataCleanup();
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

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  saveState("clean");
  stopHeartbeat();
  stopCron();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  saveState("clean");
  stopHeartbeat();
  stopCron();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  saveState("crash", err?.stack ?? String(err));
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  saveState("crash", reason instanceof Error ? (reason.stack ?? String(reason)) : String(reason));
  process.exit(1);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  saveState("fatal", err?.stack ?? String(err));
  process.exit(1);
});

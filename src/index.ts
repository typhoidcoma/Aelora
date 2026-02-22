import { installLogger } from "./logger.js";
import { loadConfig } from "./config.js";
import { loadPersona, type PersonaState } from "./persona.js";
import { initLLM, getLLMOneShot, setSystemStateProvider } from "./llm.js";
import { loadTools } from "./tool-registry.js";
import { loadAgents } from "./agent-registry.js";
import { enableAgentDispatch } from "./llm.js";
import { setToolConfigStore } from "./tools/types.js";
import { startDiscord, sendToChannel, discordClient } from "./discord.js";
import { startCron, stopCron, cronJobs } from "./cron.js";
import { startHeartbeat, stopHeartbeat, getHeartbeatState } from "./heartbeat.js";
import { registerCalendarReminder } from "./heartbeat-calendar.js";
import { registerMemoryCompaction } from "./heartbeat-memory.js";
import { startWeb, type AppState } from "./web.js";

// Install logger first so all console output is captured
installLogger();

async function main(): Promise<void> {
  console.log("Aelora 🦋 starting...\n");

  // 1. Load config
  const config = loadConfig();
  setToolConfigStore(config.tools);
  console.log(`Config: model=${config.llm.model}, mode=${config.discord.guildMode}`);

  // 2. Load persona (compose system prompt from persona/ directory)
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

  // 7. Start cron scheduler
  startCron();

  // 8. Start heartbeat
  if (config.heartbeat.enabled) {
    registerCalendarReminder();
    registerMemoryCompaction();
    startHeartbeat(config, {
      sendToChannel,
      llmOneShot: getLLMOneShot,
      config,
    });
  }

  // 9. Start web dashboard
  const appState: AppState = { config, personaState };
  startWeb(appState);

  // 10. Register live system state for LLM context
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
      cronJobs: cronJobs.map((j) => ({
        name: j.name,
        enabled: j.enabled,
        nextRun: j.nextRun?.toISOString() ?? null,
      })),
    };
  });

  console.log("\nAelora 🦋 is ready.\n");
}

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  stopHeartbeat();
  stopCron();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  stopHeartbeat();
  stopCron();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (keeping process alive):", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (keeping process alive):", reason);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

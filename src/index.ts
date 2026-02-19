import { loadConfig } from "./config.js";
import { loadSoul, type SoulState } from "./soul.js";
import { initLLM, getLLMOneShot } from "./llm.js";
import { loadTools } from "./tool-registry.js";
import { loadAgents } from "./agent-registry.js";
import { enableAgentDispatch } from "./llm.js";
import { startDiscord, sendToChannel } from "./discord.js";
import { startCron, stopCron } from "./cron.js";
import { startHeartbeat, stopHeartbeat } from "./heartbeat.js";
import { startWeb, type AppState } from "./web.js";

async function main(): Promise<void> {
  console.log("Aelora starting...\n");

  // 1. Load config
  const config = loadConfig();
  console.log(`Config: model=${config.llm.model}, mode=${config.discord.guildMode}`);

  // 2. Load soul (compose system prompt from soul/ directory)
  let soulState: SoulState | null = null;
  if (config.soul.enabled) {
    soulState = loadSoul(config.soul.dir, { botName: config.soul.botName });
    config.llm.systemPrompt = soulState.composedPrompt;
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
  startCron(config);

  // 8. Start heartbeat
  if (config.heartbeat.enabled) {
    startHeartbeat(config, {
      sendToChannel,
      llmOneShot: getLLMOneShot,
      config,
    });
  }

  // 9. Start web dashboard
  const appState: AppState = { config, soulState };
  startWeb(appState);

  console.log("\nAelora is ready.\n");
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

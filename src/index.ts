import { loadConfig, type Config } from "./config.js";
import { loadSoul, type SoulState } from "./soul.js";
import { initLLM } from "./llm.js";
import { startDiscord } from "./discord.js";
import { startCron, stopCron } from "./cron.js";
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

  // 4. Connect to Discord
  console.log("Discord: connecting...");
  await startDiscord(config);

  // 5. Start cron scheduler
  startCron(config);

  // 6. Start web dashboard
  const appState: AppState = { config, soulState };
  startWeb(appState);

  console.log("\nAelora is ready.\n");
}

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  stopCron();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  stopCron();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

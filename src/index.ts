import { loadConfig } from "./config.js";
import { initLLM } from "./llm.js";
import { startDiscord } from "./discord.js";
import { startCron, stopCron } from "./cron.js";
import { startWeb } from "./web.js";

async function main(): Promise<void> {
  console.log("Aelora starting...\n");

  // 1. Load config
  const config = loadConfig();
  console.log(`Config: model=${config.llm.model}, mode=${config.discord.guildMode}`);

  // 2. Initialize LLM client
  console.log(`LLM: ${config.llm.baseURL} / ${config.llm.model}`);
  initLLM(config);

  // 3. Connect to Discord
  console.log("Discord: connecting...");
  await startDiscord(config);

  // 4. Start cron scheduler
  startCron(config);

  // 5. Start web dashboard
  startWeb(config);

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

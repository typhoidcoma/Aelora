import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Config } from "./config.js";
import { discordClient, botUserId } from "./discord.js";
import { cronJobs } from "./cron.js";

export function startWeb(config: Config): void {
  if (!config.web.enabled) {
    console.log("Web: dashboard disabled");
    return;
  }

  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.join(__dirname, "..", "public");

  app.use(express.static(publicDir));

  // Bot status
  app.get("/api/status", (_req, res) => {
    res.json({
      connected: discordClient?.isReady() ?? false,
      username: discordClient?.user?.tag ?? null,
      userId: botUserId,
      guildCount: discordClient?.guilds.cache.size ?? 0,
      uptime: process.uptime(),
    });
  });

  // Cron job list with state
  app.get("/api/cron", (_req, res) => {
    res.json(
      cronJobs.map((j) => ({
        name: j.name,
        schedule: j.schedule,
        channelId: j.channelId,
        type: j.type,
        enabled: j.enabled,
        lastRun: j.lastRun?.toISOString() ?? null,
        nextRun: j.nextRun?.toISOString() ?? null,
        lastError: j.lastError,
      })),
    );
  });

  // Sanitized config (no secrets)
  app.get("/api/config", (_req, res) => {
    res.json({
      discord: {
        guildMode: config.discord.guildMode,
        allowDMs: config.discord.allowDMs,
        allowedChannels: config.discord.allowedChannels,
        status: config.discord.status,
      },
      llm: {
        baseURL: config.llm.baseURL,
        model: config.llm.model,
        maxHistory: config.llm.maxHistory,
        maxTokens: config.llm.maxTokens,
      },
      web: {
        port: config.web.port,
      },
    });
  });

  app.listen(config.web.port, () => {
    console.log(`Web: dashboard at http://localhost:${config.web.port}`);
  });
}

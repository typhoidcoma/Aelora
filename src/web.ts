import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Config } from "./config.js";
import { loadSoul, type SoulState } from "./soul.js";
import { getLLMOneShot } from "./llm.js";
import { discordClient, botUserId } from "./discord.js";
import { cronJobs } from "./cron.js";

export type AppState = {
  config: Config;
  soulState: SoulState | null;
};

export function startWeb(state: AppState): void {
  const { config } = state;

  if (!config.web.enabled) {
    console.log("Web: dashboard disabled");
    return;
  }

  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.join(__dirname, "..", "public");

  app.use(express.json());
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

  // Soul file inventory
  app.get("/api/soul", (_req, res) => {
    if (!state.soulState) {
      res.json({ enabled: false, files: [] });
      return;
    }

    res.json({
      enabled: true,
      loadedAt: state.soulState.loadedAt.toISOString(),
      promptLength: state.soulState.composedPrompt.length,
      files: state.soulState.files.map((f) => ({
        path: f.path,
        label: f.meta.label,
        section: f.meta.section,
        order: f.meta.order,
        enabled: f.meta.enabled,
        contentLength: f.rawContent.length,
      })),
    });
  });

  // Reload soul from disk
  app.post("/api/soul/reload", (_req, res) => {
    try {
      const newState = loadSoul(config.soul.dir, { botName: config.soul.botName });
      state.soulState = newState;
      config.llm.systemPrompt = newState.composedPrompt;

      const enabledCount = newState.files.filter((f) => f.meta.enabled).length;
      res.json({
        success: true,
        promptLength: newState.composedPrompt.length,
        fileCount: newState.files.length,
        enabledCount,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Test LLM with current soul prompt
  app.post("/api/llm/test", async (req, res) => {
    const message = req.body?.message;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    try {
      const reply = await getLLMOneShot(message);
      res.json({ reply });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.listen(config.web.port, () => {
    console.log(`Web: dashboard at http://localhost:${config.web.port}`);
  });
}

import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Config } from "./config.js";
import { loadPersona, discoverModes, type PersonaState } from "./persona.js";
import { getLLMOneShot } from "./llm.js";
import { getAllTools, toggleTool } from "./tool-registry.js";
import { getAllAgents, toggleAgent } from "./agent-registry.js";
import { getHeartbeatState } from "./heartbeat.js";
import { discordClient, botUserId } from "./discord.js";
import {
  getCronJobsForAPI,
  createCronJob,
  updateCronJob,
  toggleCronJob,
  triggerCronJob,
  deleteCronJob,
} from "./cron.js";
import { getRecentLogs, addSSEClient } from "./logger.js";
import { reboot } from "./lifecycle.js";
import { getAllSessions, deleteSession, clearAllSessions } from "./sessions.js";

export type AppState = {
  config: Config;
  personaState: PersonaState | null;
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
    res.json(getCronJobsForAPI());
  });

  // Create a new runtime cron job
  app.post("/api/cron", (req, res) => {
    const { name, schedule, timezone, channelId, type, message, prompt, enabled } = req.body ?? {};

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!schedule || typeof schedule !== "string") {
      res.status(400).json({ error: "schedule is required" });
      return;
    }
    if (!channelId || typeof channelId !== "string") {
      res.status(400).json({ error: "channelId is required" });
      return;
    }
    if (!type || !["static", "llm"].includes(type)) {
      res.status(400).json({ error: 'type must be "static" or "llm"' });
      return;
    }

    const result = createCronJob({ name, schedule, timezone, channelId, type, message, prompt, enabled });

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ success: true, name });
  });

  // Toggle a cron job on/off
  app.post("/api/cron/:name/toggle", (req, res) => {
    const { name } = req.params;
    const result = toggleCronJob(name);

    if (!result.found) {
      res.status(404).json({ error: `Job "${name}" not found` });
      return;
    }

    res.json({ name, enabled: result.enabled });
  });

  // Manually trigger a cron job
  app.post("/api/cron/:name/trigger", async (req, res) => {
    const { name } = req.params;
    const result = await triggerCronJob(name);

    if (!result.found) {
      res.status(404).json({ error: `Job "${name}" not found` });
      return;
    }

    if (result.error) {
      res.json({ success: false, error: result.error });
      return;
    }

    res.json({ success: true, output: result.output });
  });

  // Delete a runtime cron job
  app.delete("/api/cron/:name", (req, res) => {
    const { name } = req.params;
    const result = deleteCronJob(name);

    if (!result.found) {
      res.status(404).json({ error: result.error ?? `Job "${name}" not found` });
      return;
    }

    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ success: true });
  });

  // Update a runtime cron job
  app.put("/api/cron/:name", (req, res) => {
    const { name } = req.params;
    const result = updateCronJob(name, req.body ?? {});

    if (!result.found) {
      res.status(404).json({ error: result.error ?? `Job "${name}" not found` });
      return;
    }

    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ success: true, name });
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

  // Persona file inventory
  app.get("/api/persona", (_req, res) => {
    if (!state.personaState) {
      res.json({ enabled: false, files: [] });
      return;
    }

    res.json({
      enabled: true,
      activeMode: state.personaState.activeMode,
      loadedAt: state.personaState.loadedAt.toISOString(),
      promptLength: state.personaState.composedPrompt.length,
      files: state.personaState.files.map((f) => ({
        path: f.path,
        label: f.meta.label,
        section: f.meta.section,
        order: f.meta.order,
        enabled: f.meta.enabled,
        contentLength: f.rawContent.length,
      })),
    });
  });

  // Reload persona from disk
  app.post("/api/persona/reload", (_req, res) => {
    try {
      const newState = loadPersona(config.persona.dir, { botName: config.persona.botName }, config.persona.activeMode);
      state.personaState = newState;
      config.llm.systemPrompt = newState.composedPrompt;

      const enabledCount = newState.files.filter((f) => f.meta.enabled).length;
      res.json({
        success: true,
        activeMode: newState.activeMode,
        promptLength: newState.composedPrompt.length,
        fileCount: newState.files.length,
        enabledCount,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // List available persona modes
  app.get("/api/persona/modes", (_req, res) => {
    const modes = discoverModes(config.persona.dir);
    res.json({ modes, activeMode: config.persona.activeMode });
  });

  // Switch active persona mode
  app.post("/api/persona/mode", (req, res) => {
    const { mode } = req.body ?? {};
    const available = discoverModes(config.persona.dir);

    if (!mode || !available.includes(mode)) {
      res.status(400).json({ error: `Invalid mode "${mode}". Available: ${available.join(", ")}` });
      return;
    }

    try {
      config.persona.activeMode = mode;
      const newState = loadPersona(config.persona.dir, { botName: config.persona.botName }, mode);
      state.personaState = newState;
      config.llm.systemPrompt = newState.composedPrompt;

      const enabledCount = newState.files.filter((f) => f.meta.enabled).length;
      res.json({
        success: true,
        activeMode: mode,
        promptLength: newState.composedPrompt.length,
        fileCount: newState.files.length,
        enabledCount,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Test LLM with current persona prompt
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

  // Streaming LLM test (SSE)
  app.post("/api/llm/test/stream", async (req, res) => {
    const message = req.body?.message;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;
    req.on("close", () => { closed = true; });

    try {
      const reply = await getLLMOneShot(message, (token) => {
        if (!closed) {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      });
      if (!closed) {
        res.write(`data: ${JSON.stringify({ done: true, reply })}\n\n`);
      }
    } catch (err) {
      if (!closed) {
        res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      }
    } finally {
      res.end();
    }
  });

  // List all tools
  app.get("/api/tools", (_req, res) => {
    res.json(
      getAllTools().map((t) => ({
        name: t.name,
        description: t.description,
        enabled: t.enabled,
      })),
    );
  });

  // Toggle a tool on/off
  app.post("/api/tools/:name/toggle", (req, res) => {
    const { name } = req.params;
    const result = toggleTool(name);

    if (!result.found) {
      res.status(404).json({ error: `Tool "${name}" not found` });
      return;
    }

    res.json({ name, enabled: result.enabled });
  });

  // List all agents
  app.get("/api/agents", (_req, res) => {
    res.json(
      getAllAgents().map((a) => ({
        name: a.name,
        description: a.description,
        enabled: a.enabled,
        tools: a.definition.tools ?? [],
        maxIterations: a.definition.maxIterations ?? null,
        model: a.definition.model ?? null,
      })),
    );
  });

  // Toggle an agent on/off
  app.post("/api/agents/:name/toggle", (req, res) => {
    const { name } = req.params;
    const result = toggleAgent(name);

    if (!result.found) {
      res.status(404).json({ error: `Agent "${name}" not found` });
      return;
    }

    res.json({ name, enabled: result.enabled });
  });

  // Session analytics
  app.get("/api/sessions", (_req, res) => {
    res.json(getAllSessions());
  });

  // Delete a single session
  app.delete("/api/sessions/:channelId", (req, res) => {
    const { channelId } = req.params;
    const found = deleteSession(channelId);

    if (!found) {
      res.status(404).json({ error: `Session "${channelId}" not found` });
      return;
    }

    res.json({ success: true });
  });

  // Clear all sessions
  app.delete("/api/sessions", (_req, res) => {
    const count = clearAllSessions();
    res.json({ success: true, deleted: count });
  });

  // Heartbeat status
  app.get("/api/heartbeat", (_req, res) => {
    res.json(getHeartbeatState());
  });

  // Recent logs (for initial load)
  app.get("/api/logs", (_req, res) => {
    res.json(getRecentLogs());
  });

  // Reboot the bot process
  app.post("/api/reboot", (_req, res) => {
    res.json({ success: true, message: "Rebooting..." });
    // Small delay so the response is sent before process exits
    setTimeout(() => reboot(), 200);
  });

  // SSE stream for live logs
  app.get("/api/logs/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");
    addSSEClient(res);
  });

  app.listen(config.web.port, () => {
    console.log(`Web: dashboard at http://localhost:${config.web.port}`);
  });
}

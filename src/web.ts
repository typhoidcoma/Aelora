import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Config } from "./config.js";
import {
  loadPersona,
  discoverPersonas,
  discoverFiles,
  getPersonaDescriptions,
  getFileContent,
  saveFile,
  createFile,
  deleteFile,
  createPersona,
  deletePersona,
  type PersonaState,
} from "./persona.js";
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
import { getAllSessions, getSession, deleteSession, clearAllSessions } from "./sessions.js";
import { getAllMemory, getFacts, deleteFact, clearScope } from "./memory.js";

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

  // If activity enabled, serve activity page at root (Discord Activity iframe loads /)
  if (config.activity.enabled) {
    const activityDir = path.join(__dirname, "..", "activity");
    app.get("/", async (_req, res) => {
      // Inject clientId into the HTML so the Activity doesn't need a separate fetch
      const { readFile } = await import("node:fs/promises");
      try {
        let html = await readFile(path.join(activityDir, "index.html"), "utf-8");
        html = html.replace(
          "<!-- __ACTIVITY_CONFIG__ -->",
          `<script>window.__ACTIVITY_CONFIG__ = { clientId: "${config.activity.clientId}", serverUrl: "${config.activity.serverUrl ?? ""}" };</script>`,
        );
        res.type("html").send(html);
      } catch {
        res.sendFile(path.join(activityDir, "index.html"));
      }
    });
  }

  app.use(express.static(publicDir));

  // Dashboard accessible at /dashboard when activity takes over root
  app.get("/dashboard", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  // Prevent browser caching on API routes
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

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
      activePersona: state.personaState.activePersona,
      botName: state.personaState.botName,
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
      const newState = loadPersona(config.persona.dir, { botName: config.persona.botName }, config.persona.activePersona);
      state.personaState = newState;
      config.llm.systemPrompt = newState.composedPrompt;

      const enabledCount = newState.files.filter((f) => f.meta.enabled).length;
      res.json({
        success: true,
        activePersona: newState.activePersona,
        botName: newState.botName,
        promptLength: newState.composedPrompt.length,
        fileCount: newState.files.length,
        enabledCount,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // List available personas (with descriptions for card grid)
  app.get("/api/personas", (_req, res) => {
    const personas = getPersonaDescriptions(config.persona.dir);
    res.json({ personas, activePersona: config.persona.activePersona });
  });

  // Switch active persona
  app.post("/api/persona/switch", (req, res) => {
    const { persona } = req.body ?? {};
    const available = discoverPersonas(config.persona.dir);

    if (!persona || !available.includes(persona)) {
      res.status(400).json({ error: `Invalid persona "${persona}". Available: ${available.join(", ")}` });
      return;
    }

    try {
      config.persona.activePersona = persona;
      const newState = loadPersona(config.persona.dir, { botName: config.persona.botName }, persona);
      state.personaState = newState;
      config.llm.systemPrompt = newState.composedPrompt;

      const enabledCount = newState.files.filter((f) => f.meta.enabled).length;
      res.json({
        success: true,
        activePersona: persona,
        botName: newState.botName,
        promptLength: newState.composedPrompt.length,
        fileCount: newState.files.length,
        enabledCount,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // --- Persona file CRUD ---

  // Helper: reload persona after a file change and return updated state
  function reloadPersonaState() {
    const newState = loadPersona(config.persona.dir, { botName: config.persona.botName }, config.persona.activePersona);
    state.personaState = newState;
    config.llm.systemPrompt = newState.composedPrompt;
    return newState;
  }

  // List ALL persona files (across all modes) with content
  app.get("/api/persona/files", (_req, res) => {
    try {
      const allPaths = discoverFiles(config.persona.dir);
      const files = allPaths.map((relPath) => {
        const file = getFileContent(config.persona.dir, relPath);
        return file;
      }).filter(Boolean);
      res.json({ files });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get a single persona file
  app.get("/api/persona/file", (req, res) => {
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const file = getFileContent(config.persona.dir, relPath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.json(file);
  });

  // Update an existing persona file
  app.put("/api/persona/file", (req, res) => {
    const { path: relPath, content, meta } = req.body ?? {};
    if (!relPath || typeof relPath !== "string") {
      res.status(400).json({ error: "path is required" });
      return;
    }
    if (content === undefined || typeof content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const result = saveFile(config.persona.dir, relPath, content, meta ?? {});
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    try {
      reloadPersonaState();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Create a new persona file
  app.post("/api/persona/file", (req, res) => {
    const { path: relPath, content, meta } = req.body ?? {};
    if (!relPath || typeof relPath !== "string") {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const result = createFile(config.persona.dir, relPath, content ?? "", meta ?? {});
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    try {
      reloadPersonaState();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Delete a persona file
  app.delete("/api/persona/file", (req, res) => {
    const relPath = (req.body?.path ?? req.query.path) as string;
    if (!relPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const result = deleteFile(config.persona.dir, relPath);
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    try {
      reloadPersonaState();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Create a new persona
  app.post("/api/personas", (req, res) => {
    const { name, description, botName } = req.body ?? {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const result = createPersona(config.persona.dir, name, description, botName);
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ success: true, name });
  });

  // Delete a persona
  app.delete("/api/personas/:name", (req, res) => {
    const { name } = req.params;
    const result = deletePersona(config.persona.dir, name, config.persona.activePersona);
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ success: true });
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

  // Get a single session with related memories
  app.get("/api/sessions/:channelId", (req, res) => {
    const { channelId } = req.params;
    const session = getSession(channelId);

    if (!session) {
      res.status(404).json({ error: `Session "${channelId}" not found` });
      return;
    }

    // Gather related memory facts
    const memories: Record<string, { fact: string; savedAt: string }[]> = {};

    const channelFacts = getFacts(`channel:${channelId}`);
    if (channelFacts.length > 0) memories[`channel:${channelId}`] = channelFacts;

    for (const userId of Object.keys(session.users)) {
      const userFacts = getFacts(`user:${userId}`);
      if (userFacts.length > 0) memories[`user:${userId}`] = userFacts;
    }

    res.json({ ...session, memories });
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

  // Memory — list all facts
  app.get("/api/memory", (_req, res) => {
    res.json(getAllMemory());
  });

  // Memory — delete a single fact
  app.delete("/api/memory/:scope/:index", (req, res) => {
    const { scope, index } = req.params;
    const idx = parseInt(index, 10);
    if (isNaN(idx)) {
      res.status(400).json({ error: "index must be a number" });
      return;
    }

    const ok = deleteFact(scope, idx);
    if (!ok) {
      res.status(404).json({ error: "Fact not found (invalid scope or index)" });
      return;
    }

    res.json({ success: true });
  });

  // Memory — clear all facts in a scope
  app.delete("/api/memory/:scope", (req, res) => {
    const { scope } = req.params;
    const count = clearScope(scope);
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

  // --- Discord Activity support ---
  if (config.activity.enabled) {
    const activityDir = path.join(__dirname, "..", "activity");

    // Serve Unity WebGL build with CORS and gzip Content-Encoding for .gz files
    app.use("/activity", (req, res, next) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Range");
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }

      // Set Content-Encoding for pre-compressed Unity build files
      if (req.path.endsWith(".wasm.gz")) {
        res.set("Content-Encoding", "gzip");
        res.set("Content-Type", "application/wasm");
      } else if (req.path.endsWith(".js.gz")) {
        res.set("Content-Encoding", "gzip");
        res.set("Content-Type", "application/javascript");
      } else if (req.path.endsWith(".data.gz")) {
        res.set("Content-Encoding", "gzip");
        res.set("Content-Type", "application/octet-stream");
      }

      next();
    }, express.static(activityDir));

    // Activity config (exposes clientId only, never the secret)
    app.get("/api/activity/config", (_req, res) => {
      res.json({ clientId: config.activity.clientId, enabled: true });
    });

    // OAuth2 token exchange for Discord Activity SDK
    app.post("/api/activity/token", async (req, res) => {
      const { code } = req.body ?? {};
      if (!code || typeof code !== "string") {
        res.status(400).json({ error: "code is required" });
        return;
      }

      try {
        const response = await fetch("https://discord.com/api/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.activity.clientId,
            client_secret: config.activity.clientSecret,
            grant_type: "authorization_code",
            code,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error("Activity: token exchange failed:", response.status, errorText);
          res.status(response.status).json({ error: "Token exchange failed" });
          return;
        }

        const data = (await response.json()) as { access_token: string };
        res.json({ access_token: data.access_token });
      } catch (err) {
        console.error("Activity: token exchange error:", err);
        res.status(500).json({ error: "Internal token exchange error" });
      }
    });

    console.log(`Web: Activity enabled (serving ${activityDir})`);
  }

  app.listen(config.web.port, () => {
    console.log(`Web: dashboard at http://localhost:${config.web.port}`);
  });
}

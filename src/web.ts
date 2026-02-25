import express from "express";
import rateLimit from "express-rate-limit";
import { createServer, type Server } from "node:http";
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
  type PersonaState,
} from "./persona.js";
import { getLLMResponse, clearSession } from "./llm.js";
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
import { getAllSessions, getSession, deleteSession, clearAllSessions, recordMessage } from "./sessions.js";
import { getAllMemory, getFacts, deleteFact, clearScope } from "./memory.js";
import { saveActivePersona } from "./state.js";
import { loadMood, resolveLabel, classifyMood } from "./mood.js";
import { appendLog } from "./daily-log.js";
import { listAllNotes, listNotesByScope, getNote, upsertNote, deleteNote } from "./tools/notes.js";
import { listTodos, getTodoByUid, createTodo, completeTodo, updateTodoItem, deleteTodoItem } from "./tools/todo.js";
import { getAllUsers, getUser, deleteUser, updateUser } from "./users.js";
import { getClient as getCalDAVClient, parseICS, icsDateToISO } from "./tools/calendar.js";

export type AppState = {
  config: Config;
  personaState: PersonaState | null;
};

export function startWeb(state: AppState): Server | null {
  const { config } = state;

  if (!config.web.enabled) {
    console.log("Web: dashboard disabled");
    return null;
  }

  const app = express();
  app.set("trust proxy", 1);
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.join(__dirname, "..", "public");

  app.use(express.json());

  // Request logging middleware — only log mutations and errors, not dashboard polling
  app.use((req, res, next) => {
    if (req.path === "/api/logs/stream" || !req.path.startsWith("/api")) {
      return next();
    }
    const start = Date.now();
    res.on("finish", () => {
      // Log POST/PUT/DELETE (mutations) and any non-2xx responses (errors)
      if (req.method !== "GET" || res.statusCode >= 400) {
        console.log(`Web: ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
      }
    });
    next();
  });

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

  // --- Rate limiting ---
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
    skip: (req) => req.path === "/api/logs/stream", // don't count SSE connections
  });

  const llmLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "LLM rate limit exceeded. Max 60 requests per minute." },
  });

  app.use("/api", apiLimiter);
  app.use("/api/chat", llmLimiter);

  // --- Auth middleware ---
  const PUBLIC_ROUTES = [
    "/api/status",
    "/api/activity/config",
    "/api/activity/token",
    "/api/docs",
    "/api/docs/openapi.yaml",
  ];

  if (config.web.apiKey) {
    app.use("/api", (req, res, next) => {
      if (PUBLIC_ROUTES.includes(req.path)) {
        next();
        return;
      }

      const authHeader = req.headers.authorization;
      const queryToken = req.query.token as string | undefined;
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : queryToken;

      if (token === config.web.apiKey) {
        next();
        return;
      }

      res.status(401).json({ error: "Unauthorized. Provide Authorization: Bearer <key> header." });
    });

    console.log("Web: API key authentication enabled");
  }

  // --- API docs (public) ---
  const specPath = path.join(__dirname, "..", "openapi.yaml");

  app.get("/api/docs/openapi.yaml", (_req, res) => {
    res.sendFile(specPath);
  });

  app.get("/api/docs", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html><head>
  <title>Aelora API</title>
  <meta charset="utf-8">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>body{margin:0} .swagger-ui .topbar{display:none}</style>
</head><body>
  <div id="ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({url:"/api/docs/openapi.yaml",dom_id:"#ui",deepLinking:true})</script>
</body></html>`);
  });

  // Bot status (public — also tells dashboard if auth is required)
  app.get("/api/status", (_req, res) => {
    res.json({
      connected: discordClient?.isReady() ?? false,
      username: discordClient?.user?.tag ?? null,
      userId: botUserId,
      guildCount: discordClient?.guilds.cache.size ?? 0,
      uptime: process.uptime(),
      authRequired: !!config.web.apiKey,
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
    try {
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
    } catch (err) {
      console.warn("Persona: failed to read persona state:", err);
      res.json({ enabled: false, files: [], error: String(err) });
    }
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
    try {
      const personas = getPersonaDescriptions(config.persona.dir);
      res.json({ personas, activePersona: config.persona.activePersona });
    } catch (err) {
      console.warn("Persona: failed to list personas:", err);
      res.json({ personas: [], activePersona: config.persona.activePersona, error: String(err) });
    }
  });

  // Switch active persona
  app.post("/api/persona/switch", (req, res) => {
    const { persona } = req.body ?? {};
    const available = discoverPersonas(config.persona.dir);

    if (!persona || !available.includes(persona)) {
      res.status(400).json({ error: `Invalid persona "${persona}". Available: ${available.join(", ")}` });
      return;
    }

    const previousPersona = config.persona.activePersona;

    try {
      // Load BEFORE updating config — if loadPersona throws, config stays intact
      const newState = loadPersona(config.persona.dir, { botName: config.persona.botName }, persona);
      config.persona.activePersona = persona;
      state.personaState = newState;
      config.llm.systemPrompt = newState.composedPrompt;
      saveActivePersona(persona);

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
      // Restore previous persona on failure
      config.persona.activePersona = previousPersona;
      console.error(`Persona: switch to "${persona}" failed:`, err);
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // --- Persona file CRUD ---

  // Helper: reload persona after a file change — non-blocking (logs errors, never throws)
  function reloadPersonaState(): boolean {
    try {
      const newState = loadPersona(config.persona.dir, { botName: config.persona.botName }, config.persona.activePersona);
      state.personaState = newState;
      config.llm.systemPrompt = newState.composedPrompt;
      return true;
    } catch (err) {
      console.warn("Persona: reload failed after file change:", err);
      return false;
    }
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

    reloadPersonaState();
    res.json({ success: true });
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

    reloadPersonaState();
    res.json({ success: true });
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

    reloadPersonaState();
    res.json({ success: true });
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

  // --- Chat API ---

  // Chat — send message with full conversation state
  app.post("/api/chat", async (req, res) => {
    const { message, sessionId, userId, username } = req.body ?? {};

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    // Track session and user if identity provided
    if (userId && username) {
      recordMessage({ channelId: sessionId, guildId: null, channelName: sessionId, userId, username });
      updateUser(userId, username, sessionId);
    }

    try {
      const reply = await getLLMResponse(sessionId, message, undefined, userId ?? undefined);

      // Side effects (async, best-effort)
      appendLog({ channelName: sessionId, userId: userId ?? "anonymous", username: username ?? "anonymous", summary: `**User:** ${message.slice(0, 200)}\n**Bot:** ${reply.slice(0, 200)}` });
      classifyMood(reply, message).catch((err) => console.warn("Mood classify failed:", err));

      res.json({ reply, sessionId });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Chat — streaming version
  app.post("/api/chat/stream", async (req, res) => {
    const { message, sessionId, userId, username } = req.body ?? {};

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    if (userId && username) {
      recordMessage({ channelId: sessionId, guildId: null, channelName: sessionId, userId, username });
      updateUser(userId, username, sessionId);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;
    req.on("close", () => { closed = true; });

    try {
      const reply = await getLLMResponse(sessionId, message, (token) => {
        if (!closed) {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      }, userId ?? undefined);

      if (!closed) {
        res.write(`data: ${JSON.stringify({ done: true, reply })}\n\n`);
      }

      appendLog({ channelName: sessionId, userId: userId ?? "anonymous", username: username ?? "anonymous", summary: `**User:** ${message.slice(0, 200)}\n**Bot:** ${reply.slice(0, 200)}` });
      classifyMood(reply, message).catch((err) => console.warn("Mood classify failed:", err));
    } catch (err) {
      if (!closed) {
        res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      }
    } finally {
      res.end();
    }
  });

  // Chat — start new session (clear history, summary, context, and session stats)
  app.delete("/api/chat/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    clearSession(sessionId);
    deleteSession(sessionId);
    res.json({ success: true });
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

  // Memory — daily log dates
  app.get("/api/memory/logs", async (_req, res) => {
    const { listLogDates } = await import("./daily-log.js");
    res.json(listLogDates());
  });

  // Memory — read a specific daily log
  app.get("/api/memory/logs/:date", async (req, res) => {
    const { date } = req.params;
    const { readLog } = await import("./daily-log.js");
    const content = readLog(date);
    if (!content) {
      res.status(404).json({ error: `No log found for ${date}` });
      return;
    }
    res.json({ date, content });
  });

  // Memory — conversation summaries
  app.get("/api/memory/summaries", async (_req, res) => {
    const { getConversationSummaries } = await import("./llm.js");
    res.json(getConversationSummaries());
  });

  // --- Notes CRUD ---

  // Notes — list all (all scopes)
  app.get("/api/notes", (_req, res) => {
    res.json(listAllNotes());
  });

  // Notes — list by scope
  app.get("/api/notes/:scope", (req, res) => {
    const { scope } = req.params;
    const notes = listNotesByScope(scope);
    res.json({ scope, notes, count: Object.keys(notes).length });
  });

  // Notes — get single note
  app.get("/api/notes/:scope/:title", (req, res) => {
    const { scope, title } = req.params;
    const note = getNote(scope, title);
    if (!note) {
      res.status(404).json({ error: `Note "${title}" not found in scope "${scope}"` });
      return;
    }
    res.json({ scope, title, ...note });
  });

  // Notes — create or update
  app.put("/api/notes/:scope/:title", (req, res) => {
    const { scope, title } = req.params;
    const { content } = req.body ?? {};

    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const existing = getNote(scope, title);
    const note = upsertNote(scope, title, content);
    res.json({ scope, title, ...note, created: !existing });
  });

  // Notes — delete
  app.delete("/api/notes/:scope/:title", (req, res) => {
    const { scope, title } = req.params;
    const deleted = deleteNote(scope, title);
    if (!deleted) {
      res.status(404).json({ error: `Note "${title}" not found in scope "${scope}"` });
      return;
    }
    res.json({ success: true });
  });

  // --- Calendar (read-only) ---

  app.get("/api/calendar/events", async (req, res) => {
    const caldavConfig = config.tools?.caldav as
      | { serverUrl: string; username: string; password: string; authMethod: string; calendarName?: string }
      | undefined;

    if (!caldavConfig?.serverUrl || caldavConfig.serverUrl === "YOUR_CALDAV_SERVER_URL") {
      res.status(503).json({ error: "Calendar is not configured. Set caldav settings in settings.yaml under tools:" });
      return;
    }

    const maxResults = Math.min(50, Math.max(1, parseInt(req.query.maxResults as string, 10) || 10));
    const daysAhead = Math.min(365, Math.max(1, parseInt(req.query.daysAhead as string, 10) || 14));

    let client;
    try {
      client = await getCalDAVClient({
        serverUrl: caldavConfig.serverUrl,
        username: caldavConfig.username,
        password: caldavConfig.password,
        authMethod: caldavConfig.authMethod || "Basic",
      });
    } catch {
      res.status(502).json({ error: "Failed to connect to CalDAV server" });
      return;
    }

    try {
      const calendars = await client.fetchCalendars();
      if (calendars.length === 0) {
        res.json({ events: [], count: 0, daysAhead, maxResults });
        return;
      }

      const calendar =
        (caldavConfig.calendarName
          ? calendars.find((c) => c.displayName === caldavConfig.calendarName)
          : null) ?? calendars[0];

      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + daysAhead);

      const objects = await client.fetchCalendarObjects({
        calendar,
        timeRange: { start: now.toISOString(), end: end.toISOString() },
      });

      if (!objects || objects.length === 0) {
        res.json({ events: [], count: 0, daysAhead, maxResults });
        return;
      }

      const events = objects
        .filter((o) => o.data)
        .map((o) => {
          const parsed = parseICS(o.data as string, o.url, o.etag ?? "");
          return {
            ...parsed,
            dtstart: icsDateToISO(parsed.dtstart),
            dtend: icsDateToISO(parsed.dtend),
          };
        })
        .sort((a, b) => a.dtstart.localeCompare(b.dtstart))
        .slice(0, maxResults);

      res.json({ events, count: events.length, daysAhead, maxResults });
    } catch {
      res.status(500).json({ error: "Calendar query failed" });
    }
  });

  // --- Todos (CalDAV VTODO) ---

  const getTodoClient = async () => {
    const caldavConfig = state.config.tools?.caldav as
      | { serverUrl: string; username: string; password: string; authMethod: string; calendarName?: string }
      | undefined;
    if (!caldavConfig?.serverUrl) throw new Error("CalDAV not configured");
    const client = await getCalDAVClient({
      serverUrl: caldavConfig.serverUrl,
      username: caldavConfig.username,
      password: caldavConfig.password,
      authMethod: caldavConfig.authMethod || "Basic",
    });
    return { client, calendarName: caldavConfig.calendarName };
  };

  // List todos, optionally filter by ?status=pending|completed|all
  app.get("/api/todos", async (req, res) => {
    try {
      const { client, calendarName } = await getTodoClient();
      const status = (req.query.status as string) || "all";
      const items = await listTodos(client, calendarName, status as "all" | "pending" | "completed");
      res.json({ todos: items, count: items.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not configured")) {
        res.status(503).json({ error: "CalDAV not configured" });
      } else {
        res.status(502).json({ error: `CalDAV error: ${msg}` });
      }
    }
  });

  // Get single todo by UID
  app.get("/api/todos/:uid", async (req, res) => {
    try {
      const { client, calendarName } = await getTodoClient();
      const item = await getTodoByUid(client, calendarName, req.params.uid);
      if (!item) { res.status(404).json({ error: `Todo "${req.params.uid}" not found` }); return; }
      res.json(item);
    } catch (err) {
      res.status(502).json({ error: `CalDAV error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // Create todo
  app.post("/api/todos", async (req, res) => {
    const { title, description, priority, dueDate } = req.body ?? {};
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    try {
      const { client, calendarName } = await getTodoClient();
      const item = await createTodo(client, calendarName, { title, description, priority, dueDate });
      res.status(201).json(item);
    } catch (err) {
      res.status(502).json({ error: `CalDAV error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // Update todo
  app.put("/api/todos/:uid", async (req, res) => {
    const { title, description, priority, dueDate, completed } = req.body ?? {};
    try {
      const { client, calendarName } = await getTodoClient();
      if (completed === true) {
        const item = await completeTodo(client, calendarName, req.params.uid);
        if (!item) { res.status(404).json({ error: `Todo "${req.params.uid}" not found` }); return; }
        res.json(item);
      } else {
        const item = await updateTodoItem(client, calendarName, req.params.uid, { title, description, priority, dueDate });
        if (!item) { res.status(404).json({ error: `Todo "${req.params.uid}" not found` }); return; }
        res.json(item);
      }
    } catch (err) {
      res.status(502).json({ error: `CalDAV error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // Delete todo
  app.delete("/api/todos/:uid", async (req, res) => {
    try {
      const { client, calendarName } = await getTodoClient();
      const deleted = await deleteTodoItem(client, calendarName, req.params.uid);
      if (!deleted) { res.status(404).json({ error: `Todo "${req.params.uid}" not found` }); return; }
      res.json({ success: true });
    } catch (err) {
      res.status(502).json({ error: `CalDAV error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // --- Users ---

  // Users — list all profiles
  app.get("/api/users", (_req, res) => {
    res.json(getAllUsers());
  });

  // Users — get single profile with memory facts
  app.get("/api/users/:userId", (req, res) => {
    const { userId } = req.params;
    const profile = getUser(userId);
    if (!profile) {
      res.status(404).json({ error: `User "${userId}" not found` });
      return;
    }
    const facts = getFacts(`user:${userId}`);
    res.json({ ...profile, facts });
  });

  // Users — delete profile
  app.delete("/api/users/:userId", (req, res) => {
    const { userId } = req.params;
    const deleted = deleteUser(userId);
    if (!deleted) {
      res.status(404).json({ error: `User "${userId}" not found` });
      return;
    }

    // Cascade: also clear user memory facts
    const memoryCleared = clearScope(`user:${userId}`);

    res.json({ success: true, memoryCleared });
  });

  // Heartbeat status
  app.get("/api/heartbeat", (_req, res) => {
    res.json(getHeartbeatState());
  });

  // Current mood (Plutchik's wheel)
  app.get("/api/mood", (_req, res) => {
    const mood = loadMood();
    if (!mood) return res.json({ active: false });
    res.json({
      active: true,
      emotion: mood.emotion,
      intensity: mood.intensity,
      label: resolveLabel(mood),
      secondary: mood.secondary ?? null,
      note: mood.note ?? null,
      updatedAt: mood.updatedAt,
    });
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

  // --- Data export ---

  app.get("/api/export", async (req, res) => {
    const requested = typeof req.query.sections === "string"
      ? req.query.sections.split(",").map((s) => s.trim())
      : null;

    const include = (name: string) => !requested || requested.includes(name);

    const bundle: Record<string, unknown> = {};
    if (include("memory")) bundle.memory = getAllMemory();
    if (include("sessions")) bundle.sessions = getAllSessions();
    if (include("notes")) bundle.notes = listAllNotes();
    if (include("users")) bundle.users = getAllUsers();
    if (include("cron")) bundle.cron = getCronJobsForAPI();
    if (include("mood")) bundle.mood = loadMood();
    if (include("personas")) bundle.personas = getPersonaDescriptions(config.persona.dir);

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename=aelora-export-${date}.json`);
    res.json(bundle);
  });

  const server = createServer(app);
  server.listen(config.web.port, "0.0.0.0", () => {
    console.log(`Web: dashboard at http://0.0.0.0:${config.web.port}`);
  });
  return server;
}

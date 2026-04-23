import express from "express";
import rateLimit from "express-rate-limit";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
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
import { getLLMResponse, getSystemDirectiveResponse, clearSession } from "./llm.js";
import { getAllTools, toggleTool, isToolEnabled, executeTool } from "./tool-registry.js";
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
import { getRecentLogs, addSSEClient, getLiveClientMetrics } from "./logger.js";
import { reboot } from "./lifecycle.js";
import { getAllSessions, getSession, deleteSession, clearAllSessions, recordMessage } from "./sessions.js";
import { getAllMemory, getFacts, deleteFact, clearScope } from "./memory.js";
import { saveActivePersona } from "./state.js";
import { loadMood, resolveLabel, resolveDyad, classifyMood } from "./mood.js";
import { moodStateToVector, zeroVector } from "./emotion-vector.js";
import { extractFacts, trackMessage } from "./fact-extractor.js";
import { appendLog } from "./daily-log.js";
import { listAllNotes, listNotesByScope, getNote, upsertNote, deleteNote } from "./tools/notes.js";
import { listTasks, getTaskByUid, createTask, completeTask, updateTask, deleteTask, getGoogleConfig, resolveUserTaskList } from "./tools/tasks.js";
import { listEvents } from "./tools/google-calendar.js";
import { resolveUserCalendar } from "./tools/calendar.js";
import { getAllUsers, getUser, deleteUser, updateUser } from "./users.js";
import { googleFetch } from "./tools/_google-auth.js";
import { getKnowledgeBaseStats, syncKnowledgeBase, getFileChunks, removeFile } from "./knowledge-base.js";
import { LinearClient } from "@linear/sdk";
import { getTokenStats, resetTokenStats } from "./token-tracker.js";
import {
  tryGetSupabaseClient,
  getQuestsSupabaseClient,
  hasQuestsServiceRoleClient,
  ensureUserProfile,
} from "./supabase.js";
import {
  createQuestRow,
  completeQuestRow,
  setQuestFavoriteRow,
  listQuestRows,
  updateQuestRow,
  deleteQuestRow,
  isValidUuid,
  probeQuestsTable,
  type QuestDbFailure,
} from "./tools/quest.js";

export type AppState = {
  config: Config;
  personaState: PersonaState | null;
};

/** Wrap async route handlers so rejected promises reach the global error handler. */
const asyncHandler = (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => { fn(req, res, next).catch(next); };

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
  const basePath = (config.web.basePath || "").replace(/\/$/, "");
  const MAX_STREAM_MESSAGE_CHARS = 12_000;
  const MAX_EXPORT_BYTES = 5 * 1024 * 1024;

  // Strip basePath prefix so routes match without it (e.g. /aelora/api/status -> /api/status)
  if (basePath) {
    app.use((req, _res, next) => {
      if (req.url.startsWith(basePath)) {
        req.url = req.url.slice(basePath.length) || "/";
      }
      next();
    });
    console.log(`Web: base path "${basePath}" - stripping prefix from incoming requests`);
  }

  app.use(express.json());

  // CORS - allow cross-origin requests to /api from any origin
  app.use("/api", (req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Request logging middleware  -  assigns request ID and logs mutations/errors
  const logAllRequests = config.logger?.logAllRequests ?? false;
  app.use((req, res, next) => {
    if (req.path === "/api/logs/stream" || !req.path.startsWith("/api")) {
      return next();
    }
    const requestId = randomUUID().slice(0, 8);
    res.locals.requestId = requestId;
    const start = Date.now();
    res.on("finish", () => {
      const elapsed = Date.now() - start;
      const shouldLog = logAllRequests
        || req.method !== "GET"
        || (res.statusCode >= 400 && res.statusCode !== 404);
      if (shouldLog) {
        const slow = elapsed > 1000 ? " SLOW" : "";
        console.log(`Web: [${requestId}] ${req.method} ${req.path} ${res.statusCode} ${elapsed}ms${slow}`);
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
  const isSensitiveRequest = (req: express.Request): boolean => {
    if (req.path === "/api/reboot" || req.path === "/api/export") return true;
    if (req.path === "/api/persona/file" && ["PUT", "POST", "DELETE"].includes(req.method)) return true;
    return false;
  };
  let lastQueryTokenWarningAt = 0;

  const isLocalRequest = (ip: string | undefined): boolean => {
    if (!ip) return false;
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  };

  const readAuth = (
    req: express.Request,
    opts?: { allowQueryToken?: boolean; requireSensitive?: boolean },
  ): { ok: boolean; usedQueryToken: boolean; error?: string } => {
    const allowQueryToken = opts?.allowQueryToken ?? config.web.auth.allowQueryToken;
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const queryToken = allowQueryToken ? (req.query.token as string | undefined) : undefined;

    if (config.web.apiKey) {
      const token = bearer ?? queryToken;
      if (token === config.web.apiKey) {
        return { ok: true, usedQueryToken: !bearer && !!queryToken };
      }
      return { ok: false, usedQueryToken: false, error: "Unauthorized. Provide Authorization: Bearer <key> header." };
    }

    if (opts?.requireSensitive && !isLocalRequest(req.ip)) {
      return { ok: false, usedQueryToken: false, error: "Sensitive route requires local request or API key auth." };
    }

    return { ok: true, usedQueryToken: false };
  };

  const addQueryTokenDeprecationHeaders = (res: express.Response): void => {
    res.setHeader("Warning", "299 - Query token auth is deprecated; use Authorization: Bearer");
    res.setHeader("Deprecation", "true");
  };

  app.use("/api", (req, res, next) => {
    if (PUBLIC_ROUTES.includes(req.path)) {
      next();
      return;
    }

    const auth = readAuth(req);
    if (!auth.ok) {
      res.status(401).json({ error: auth.error });
      return;
    }

    if (auth.usedQueryToken) {
      addQueryTokenDeprecationHeaders(res);
      if (Date.now() - lastQueryTokenWarningAt > 60_000) {
        console.warn("Web: query-token auth used; migrate clients to Authorization header");
        lastQueryTokenWarningAt = Date.now();
      }
    }
    next();
  });

  app.use("/api", (req, res, next) => {
    if (!isSensitiveRequest(req)) {
      next();
      return;
    }

    const auth = readAuth(req, { requireSensitive: true });
    if (!auth.ok) {
      const status = config.web.apiKey ? 401 : 403;
      res.status(status).json({ error: auth.error });
      return;
    }

    if (auth.usedQueryToken) {
      addQueryTokenDeprecationHeaders(res);
    }
    next();
  });

  if (config.web.apiKey) {
    console.log("Web: API key authentication enabled");
  } else {
    console.warn("Web: API key not set; sensitive routes restricted to local requests");
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
  <script>SwaggerUIBundle({url:${JSON.stringify(`${basePath}/api/docs/openapi.yaml`)},dom_id:"#ui",deepLinking:true})</script>
</body></html>`);
  });

  // Bot status (public  -  also tells dashboard if auth is required)
  app.get("/api/status", (_req, res) => {
    const liveClients = getLiveClientMetrics();
    res.json({
      connected: discordClient?.isReady() ?? false,
      username: discordClient?.user?.tag ?? null,
      userId: botUserId,
      guildCount: discordClient?.guilds.cache.size ?? 0,
      uptime: process.uptime(),
      authRequired: !!config.web.apiKey,
      liveClients,
    });
  });

  // Token usage stats
  app.get("/api/tokens", (_req, res) => {
    res.json(getTokenStats());
  });

  // External API health stats (rolling 1-hour window)
  app.get("/api/health", async (_req, res) => {
    const { getHealthReport } = await import("./api-health.js");
    res.json(getHealthReport());
  });

  // Reset token stats
  app.post("/api/tokens/reset", (_req, res) => {
    resetTokenStats();
    res.json({ success: true });
  });

  // LLM transport (HTTP/2 + keepalive) diagnostics
  app.get("/api/llm/transport", async (_req, res) => {
    const { getLLMTransportStats } = await import("./llm/http-client.js");
    const { getEmbeddingCacheStats } = await import("./vector-store.js");
    const { getAsyncWriteStats } = await import("./async-write-queue.js");
    res.json({
      transport: getLLMTransportStats(),
      embeddingCache: getEmbeddingCacheStats(),
      asyncWriteQueue: getAsyncWriteStats(),
    });
  });

  // Cron job list with state
  app.get("/api/cron", (_req, res) => {
    res.json(getCronJobsForAPI());
  });

  // Create a new runtime cron job
  app.post("/api/cron", (req, res) => {
    const { name, schedule, timezone, channelId, type, message, prompt, enabled, silent } = req.body ?? {};

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!schedule || typeof schedule !== "string") {
      res.status(400).json({ error: "schedule is required" });
      return;
    }
    if (!silent && (!channelId || typeof channelId !== "string")) {
      res.status(400).json({ error: "channelId is required for non-silent jobs" });
      return;
    }
    if (!type || !["static", "llm"].includes(type)) {
      res.status(400).json({ error: 'type must be "static" or "llm"' });
      return;
    }

    const result = createCronJob({ name, schedule, timezone, channelId, type, message, prompt, enabled, silent: !!silent });

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
      // Load BEFORE updating config  -  if loadPersona throws, config stays intact
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

  // Helper: reload persona after a file change  -  non-blocking (logs errors, never throws)
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

  // Chat  -  send message with full conversation state
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
    trackMessage(sessionId);

    try {
      const reply = await getLLMResponse(sessionId, message, undefined, userId ?? undefined);

      // Side effects (async, best-effort)
      appendLog({ channelName: sessionId, userId: userId ?? "anonymous", username: username ?? "anonymous", summary: `**User:** ${message.slice(0, 200)}\n**Bot:** ${reply.slice(0, 200)}` });
      classifyMood(reply, message, sessionId).catch((err) => console.warn("Mood classify failed:", err));
      if (config.memory.autoExtract !== false) {
        extractFacts(message, reply, sessionId, userId ?? undefined)
          .catch((err) => console.warn("Fact extraction failed:", err));
      }

      res.json({ reply, sessionId });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err);
      console.error("Web chat error:", errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  // Chat  -  streaming version
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
    if (message.length > MAX_STREAM_MESSAGE_CHARS) {
      res.status(413).json({ error: `message too large (max ${MAX_STREAM_MESSAGE_CHARS} chars)` });
      return;
    }

    if (userId && username) {
      recordMessage({ channelId: sessionId, guildId: null, channelName: sessionId, userId, username });
      updateUser(userId, username, sessionId);
    }
    trackMessage(sessionId);

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
      classifyMood(reply, message, sessionId).catch((err) => console.warn("Mood classify failed:", err));
      if (config.memory.autoExtract !== false) {
        extractFacts(message, reply, sessionId, userId ?? undefined)
          .catch((err) => console.warn("Fact extraction failed:", err));
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err);
      console.error("Web chat/stream error:", errMsg);
      if (!closed) {
        res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      }
    } finally {
      res.end();
    }
  });

  // Chat  -  system directive (frontend-issued instruction, NOT a user message)
  app.post("/api/chat/system", async (req, res) => {
    const { directive, sessionId, userId } = req.body ?? {};

    if (!directive || typeof directive !== "string") {
      res.status(400).json({ error: "directive is required" });
      return;
    }
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }
    if (directive.length > MAX_STREAM_MESSAGE_CHARS) {
      res.status(413).json({ error: `directive too large (max ${MAX_STREAM_MESSAGE_CHARS} chars)` });
      return;
    }

    trackMessage(sessionId);

    try {
      const reply = await getSystemDirectiveResponse(sessionId, directive, undefined, userId ?? undefined);

      appendLog({ channelName: sessionId, userId: userId ?? "system", username: "system", summary: `**System directive:** ${directive.slice(0, 200)}\n**Bot:** ${reply.slice(0, 200)}` });

      res.json({ reply, sessionId });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err);
      console.error("Web chat/system error:", errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  // Chat  -  system directive streaming version
  app.post("/api/chat/system/stream", async (req, res) => {
    const { directive, sessionId, userId } = req.body ?? {};

    if (!directive || typeof directive !== "string") {
      res.status(400).json({ error: "directive is required" });
      return;
    }
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }
    if (directive.length > MAX_STREAM_MESSAGE_CHARS) {
      res.status(413).json({ error: `directive too large (max ${MAX_STREAM_MESSAGE_CHARS} chars)` });
      return;
    }

    trackMessage(sessionId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;
    req.on("close", () => { closed = true; });

    try {
      const reply = await getSystemDirectiveResponse(sessionId, directive, (token) => {
        if (!closed) {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      }, userId ?? undefined);

      if (!closed) {
        res.write(`data: ${JSON.stringify({ done: true, reply })}\n\n`);
      }

      appendLog({ channelName: sessionId, userId: userId ?? "system", username: "system", summary: `**System directive:** ${directive.slice(0, 200)}\n**Bot:** ${reply.slice(0, 200)}` });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err);
      console.error("Web chat/system/stream error:", errMsg);
      if (!closed) {
        res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      }
    } finally {
      res.end();
    }
  });

  // Chat  -  start new session (clear history, summary, context, and session stats)
  app.delete("/api/chat/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    clearSession(sessionId);
    deleteSession(sessionId);
    res.json({ success: true });
  });

  // List all tools (with parameter schemas for client validation)
  app.get("/api/tools", (_req, res) => {
    res.json(
      getAllTools().map((t) => ({
        name: t.name,
        description: t.description,
        enabled: t.enabled,
        parameters: t.parameters ?? null,
      })),
    );
  });

  // Single tool detail
  app.get("/api/tools/:name", (req, res) => {
    const tool = getAllTools().find((t) => t.name === req.params.name);
    if (!tool) {
      res.status(404).json({ error: `Tool "${req.params.name}" not found` });
      return;
    }
    res.json({
      name: tool.name,
      description: tool.description,
      enabled: tool.enabled,
      parameters: tool.parameters ?? null,
    });
  });

  // Execute a tool directly via REST API
  app.post("/api/tools/:name/execute", asyncHandler(async (req, res) => {
    const name = req.params.name as string;
    const { args = {}, channelId = null, userId = null } = req.body ?? {};

    const tool = getAllTools().find((t) => t.name === name);
    if (!tool) {
      res.status(404).json({ error: `Tool "${name}" not found` });
      return;
    }
    if (!tool.enabled) {
      res.status(400).json({ error: `Tool "${name}" is currently disabled` });
      return;
    }

    const result = await executeTool(name, args, channelId, userId);
    const success = !result.text.startsWith("Error:");
    res.json({
      success,
      tool: name,
      result: result.text,
      ...(result.data !== undefined ? { data: result.data } : {}),
    });
  }));

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

  // Memory  -  list all facts
  app.get("/api/memory", (_req, res) => {
    res.json(getAllMemory());
  });

  // Memory  -  get facts for a specific scope (e.g. /api/memory/scope?name=user:123)
  app.get("/api/memory/scope", (req, res) => {
    const scope = req.query.name as string | undefined;
    if (!scope) {
      res.status(400).json({ error: "Missing ?name= query parameter" });
      return;
    }
    const facts = getFacts(scope);
    res.json({ scope, facts });
  });

  // Memory  -  delete a single fact
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

  // Memory  -  clear all facts in a scope
  app.delete("/api/memory/:scope", (req, res) => {
    const { scope } = req.params;
    const count = clearScope(scope);
    res.json({ success: true, deleted: count });
  });

  // Memory  -  daily log dates
  app.get("/api/memory/logs", asyncHandler(async (_req, res) => {
    const { listLogDates } = await import("./daily-log.js");
    res.json(listLogDates());
  }));

  // Memory  -  read a specific daily log
  app.get("/api/memory/logs/:date", asyncHandler(async (req, res) => {
    const date = req.params.date as string;
    const { readLog } = await import("./daily-log.js");
    const content = readLog(date);
    if (!content) {
      res.status(404).json({ error: `No log found for ${date}` });
      return;
    }
    res.json({ date, content });
  }));

  // Memory  -  conversation summaries
  app.get("/api/memory/summaries", asyncHandler(async (_req, res) => {
    const { getConversationSummaries } = await import("./llm.js");
    res.json(getConversationSummaries());
  }));

  // --- Notes CRUD ---

  // Notes  -  list all (all scopes)
  app.get("/api/notes", (_req, res) => {
    res.json(listAllNotes());
  });

  // Notes  -  list by scope
  app.get("/api/notes/:scope", (req, res) => {
    const { scope } = req.params;
    const notes = listNotesByScope(scope);
    res.json({ scope, notes, count: Object.keys(notes).length });
  });

  // Notes  -  get single note
  app.get("/api/notes/:scope/:title", (req, res) => {
    const { scope, title } = req.params;
    const note = getNote(scope, title);
    if (!note) {
      res.status(404).json({ error: `Note "${title}" not found in scope "${scope}"` });
      return;
    }
    res.json({ scope, title, ...note });
  });

  // Notes  -  create or update
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

  // Notes  -  delete
  app.delete("/api/notes/:scope/:title", (req, res) => {
    const { scope, title } = req.params;
    const deleted = deleteNote(scope, title);
    if (!deleted) {
      res.status(404).json({ error: `Note "${title}" not found in scope "${scope}"` });
      return;
    }
    res.json({ success: true });
  });

  // --- Knowledge Base ---

  app.get("/api/knowledge", (_req, res) => {
    res.json(getKnowledgeBaseStats());
  });

  app.post("/api/knowledge/sync", async (_req, res) => {
    try {
      const result = await syncKnowledgeBase();
      if (!result) {
        res.status(503).json({ error: "Knowledge base not enabled or vector store not ready" });
        return;
      }
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/knowledge/files/:fileId/chunks", async (req, res) => {
    const { fileId } = req.params;
    try {
      const chunks = await getFileChunks(fileId);
      res.json({ fileId, chunks });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete("/api/knowledge/files/:fileId", async (req, res) => {
    const { fileId } = req.params;
    try {
      const result = await removeFile(fileId);
      if (!result) {
        res.status(404).json({ error: "File not found in knowledge base" });
        return;
      }
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // --- Calendar (per-user; Patyna may send ?discordUserId= or ?supabaseUserId=) ---

  /** Dashboard / Patyna: header or ?userId= | ?discordUserId= | ?supabaseUserId= */
  function resolveApiUserId(req: express.Request): string | undefined {
    const h = (req.headers["x-discord-user-id"] as string | undefined)?.trim();
    if (h) return h;
    const q = req.query;
    for (const key of ["userId", "discordUserId", "supabaseUserId"] as const) {
      const v = q[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  }

  app.get("/api/calendar/events", async (req, res) => {
    if (!isToolEnabled("calendar")) {
      res.status(404).json({ error: "Calendar tool is not enabled" });
      return;
    }

    const discordUserId = resolveApiUserId(req);
    if (!discordUserId) {
      res.status(400).json({
        error:
          "User id required: X-Discord-User-Id header or query ?userId=, ?discordUserId=, or ?supabaseUserId= (calendar)",
      });
      return;
    }

    let googleConfig;
    try {
      googleConfig = getGoogleConfig(config.tools as Record<string, Record<string, unknown>> | undefined);
    } catch {
      res.status(503).json({ error: "Google not configured. Add google.clientId/clientSecret/refreshToken to settings.yaml under tools:" });
      return;
    }

    const maxResults = Math.min(50, Math.max(1, parseInt(req.query.maxResults as string, 10) || 10));
    const daysRaw = req.query.days ?? req.query.daysAhead;
    const daysAhead = Math.min(
      365,
      Math.max(1, parseInt(typeof daysRaw === "string" ? daysRaw : String(daysRaw ?? ""), 10) || 14),
    );

    try {
      const calendarId = await resolveUserCalendar(googleConfig, discordUserId);
      if (!calendarId) {
        res.json({ events: [], count: 0, daysAhead, maxResults });
        return;
      }
      const events = await listEvents(googleConfig, calendarId, { maxResults, daysAhead });

      const mapped = events.map((e) => ({
        uid: e.id,
        summary: e.summary ?? "Untitled",
        description: e.description?.replace(/\n?\[user:\d+(?::[^\]]+)?\]/, "").trim() || undefined,
        location: e.location,
        dtstart: e.start.dateTime ?? e.start.date ?? "",
        dtend: e.end.dateTime ?? e.end.date ?? "",
      }));

      res.json({ events: mapped, count: mapped.length, daysAhead, maxResults });
    } catch (err) {
      res.status(500).json({ error: `Calendar query failed: ${err instanceof Error ? err.message : "unknown"}` });
    }
  });

  // Aggregate calendar: all users' events merged (for Home tab)
  app.get("/api/calendar/all-events", async (req, res) => {
    if (!isToolEnabled("calendar")) {
      res.status(404).json({ error: "Calendar tool is not enabled" });
      return;
    }

    let googleConfig;
    try {
      googleConfig = getGoogleConfig(config.tools as Record<string, Record<string, unknown>> | undefined);
    } catch {
      res.status(503).json({ error: "Google not configured" });
      return;
    }

    const maxResults = Math.min(50, Math.max(1, parseInt(req.query.maxResults as string, 10) || 10));
    const daysAhead = Math.min(365, Math.max(1, parseInt(req.query.daysAhead as string, 10) || 14));

    try {
      const users = getAllUsers();
      const userIds = Object.keys(users);

      const results = await Promise.allSettled(
        userIds.map(async (userId) => {
          const calendarId = await resolveUserCalendar(googleConfig, userId);
          if (!calendarId) return [];
          const events = await listEvents(googleConfig, calendarId, { maxResults: 20, daysAhead });
          const username = users[userId]?.username ?? userId;
          return events.map((e) => ({
            uid: e.id,
            summary: e.summary ?? "Untitled",
            description: e.description?.replace(/\n?\[user:\d+(?::[^\]]+)?\]/, "").trim() || undefined,
            location: e.location,
            dtstart: e.start.dateTime ?? e.start.date ?? "",
            dtend: e.end.dateTime ?? e.end.date ?? "",
            user: { userId, username },
          }));
        }),
      );

      const allEvents = results
        .filter((r): r is PromiseFulfilledResult<any[]> => r.status === "fulfilled")
        .flatMap((r) => r.value)
        .sort((a, b) => (a.dtstart > b.dtstart ? 1 : a.dtstart < b.dtstart ? -1 : 0))
        .slice(0, maxResults);

      res.json({ events: allEvents, count: allEvents.length, daysAhead });
    } catch (err) {
      res.status(500).json({ error: `Calendar query failed: ${err instanceof Error ? err.message : "unknown"}` });
    }
  });

  // --- Tasks ---

  const getGoogleTasksConfig = () =>
    getGoogleConfig(state.config.tools as Record<string, Record<string, unknown>> | undefined);

  // Helper: resolve task list for API requests
  function requireTaskUser(req: express.Request, res: express.Response): string | null {
    const uid = resolveApiUserId(req);
    if (!uid) {
      res.status(400).json({
        error:
          "User id required: X-Discord-User-Id header or ?userId=, ?discordUserId=, or ?supabaseUserId= (tasks)",
      });
      return null;
    }
    return uid;
  }

  // List tasks, optionally filter by ?status=pending|completed|all
  const handleTasksList = async (req: express.Request, res: express.Response): Promise<void> => {
    if (!isToolEnabled("tasks")) {
      res.status(404).json({ error: "Tasks tool is not enabled" });
      return;
    }
    const discordUserId = requireTaskUser(req, res);
    if (!discordUserId) return;
    try {
      const googleConfig = getGoogleTasksConfig();
      const taskListId = await resolveUserTaskList(googleConfig, discordUserId);
      const status = (req.query.status as string) || "all";
      const items = await listTasks(googleConfig, taskListId, status as "all" | "pending" | "completed");
      res.json({ tasks: items, count: items.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not configured")) {
        res.status(503).json({ error: msg });
      } else {
        res.status(502).json({ error: `Tasks error: ${msg}` });
      }
    }
  };

  app.get("/api/tasks", handleTasksList);
  // Patyna aelora-client compatibility (same as /api/tasks)
  app.get("/api/todos", handleTasksList);

  // Get single task by UID
  app.get("/api/tasks/:uid", async (req, res) => {
    if (!isToolEnabled("tasks")) { res.status(404).json({ error: "Tasks tool is not enabled" }); return; }
    const discordUserId = requireTaskUser(req, res);
    if (!discordUserId) return;
    try {
      const googleConfig = getGoogleTasksConfig();
      const taskListId = await resolveUserTaskList(googleConfig, discordUserId);
      const item = await getTaskByUid(googleConfig, req.params.uid, taskListId);
      if (!item) { res.status(404).json({ error: `Task "${req.params.uid}" not found` }); return; }
      res.json(item);
    } catch (err) {
      res.status(502).json({ error: `Tasks error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // Create task
  app.post("/api/tasks", async (req, res) => {
    if (!isToolEnabled("tasks")) { res.status(404).json({ error: "Tasks tool is not enabled" }); return; }
    const discordUserId = requireTaskUser(req, res);
    if (!discordUserId) return;
    const { title, description, priority, dueDate } = req.body ?? {};
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    try {
      const googleConfig = getGoogleTasksConfig();
      const taskListId = await resolveUserTaskList(googleConfig, discordUserId);
      const item = await createTask(googleConfig, taskListId, { title, description, priority, dueDate });
      res.status(201).json(item);
    } catch (err) {
      res.status(502).json({ error: `Tasks error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // Update task (or mark complete with { completed: true })
  // Requires X-Discord-User-Id header for user scoping
  app.put("/api/tasks/:uid", async (req, res) => {
    if (!isToolEnabled("tasks")) { res.status(404).json({ error: "Tasks tool is not enabled" }); return; }
    const discordUserId = requireTaskUser(req, res);
    if (!discordUserId) return;
    const { title, description, priority, dueDate, completed } = req.body ?? {};
    try {
      const googleConfig = getGoogleTasksConfig();
      const taskListId = await resolveUserTaskList(googleConfig, discordUserId);
      if (completed === true) {
        const item = await completeTask(googleConfig, req.params.uid, taskListId);
        if (!item) { res.status(404).json({ error: `Task "${req.params.uid}" not found` }); return; }

        res.json(item);
      } else {
        const item = await updateTask(googleConfig, req.params.uid, { title, description, priority, dueDate }, taskListId);
        if (!item) { res.status(404).json({ error: `Task "${req.params.uid}" not found` }); return; }
        res.json(item);
      }
    } catch (err) {
      res.status(502).json({ error: `Tasks error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // Delete task
  app.delete("/api/tasks/:uid", async (req, res) => {
    if (!isToolEnabled("tasks")) { res.status(404).json({ error: "Tasks tool is not enabled" }); return; }
    const discordUserId = requireTaskUser(req, res);
    if (!discordUserId) return;
    try {
      const googleConfig = getGoogleTasksConfig();
      const taskListId = await resolveUserTaskList(googleConfig, discordUserId);
      const deleted = await deleteTask(googleConfig, req.params.uid, taskListId);
      if (!deleted) { res.status(404).json({ error: `Task "${req.params.uid}" not found` }); return; }
      res.json({ success: true });
    } catch (err) {
      res.status(502).json({ error: `Tasks error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  /** Patyna quests: uses service role when `supabase.serviceRoleKey` is set (bypasses RLS). */
  function requireSupabaseForQuests(res: express.Response) {
    const sb = getQuestsSupabaseClient();
    if (!sb) {
      res.status(503).json({
        error: "Supabase is not configured. Add supabase.url and supabase.anonKey to settings.yaml.",
        source: "aelora_config",
      });
      return null;
    }
    return sb;
  }

  /**
   * Quest creates/completions must use the service-role Supabase client; anon inserts/updates hit RLS
   * from this server (no end-user JWT). Patyna should call with `Authorization: Bearer <web.apiKey>` when
   * `web.apiKey` is set, and settings must include `supabase.serviceRoleKey`.
   */
  function requireQuestWriteSupabase(res: express.Response) {
    const sb = requireSupabaseForQuests(res);
    if (!sb) return null;
    if (!hasQuestsServiceRoleClient()) {
      res.status(503).json({
        error:
          "Patyna quest writes require supabase.serviceRoleKey in settings.yaml. " +
          "This API inserts and updates `quests` on behalf of signed-in users; the service role bypasses RLS. " +
          "The anon key alone cannot perform those writes from the server.",
        source: "aelora_config",
        hint:
          "Supabase Dashboard → Project Settings → API → service_role key. Keep it server-only (never in Patyna .env or the browser).",
      });
      return null;
    }
    return sb;
  }

  function jsonQuestFailure(
    res: express.Response,
    failure: QuestDbFailure,
    extra?: Record<string, unknown>,
  ): void {
    res.status(failure.httpStatus).json({
      error: failure.error,
      ...(failure.code ? { code: failure.code } : {}),
      ...(failure.hint ? { hint: failure.hint } : {}),
      ...(failure.details ? { details: failure.details } : {}),
      source: "supabase",
      ...extra,
    });
  }

  // GET /api/supabase/status  -  whether Aelora can read `quests` (connectivity + schema/RLS)
  app.get("/api/supabase/status", asyncHandler(async (_req, res) => {
    const url = config.supabase?.url;
    const hasKey = !!(config.supabase?.anonKey && String(config.supabase.anonKey).length > 0);
    if (!url || !hasKey) {
      res.json({
        configured: false,
        quests: null,
        message: "Add supabase.url and supabase.anonKey in settings.yaml.",
      });
      return;
    }

    const sb = getQuestsSupabaseClient();
    if (!sb) {
      res.json({
        configured: true,
        clientReady: false,
        quests: { readable: false, error: "Supabase client did not initialize (check URL and keys)." },
      });
      return;
    }

    const probe = await probeQuestsTable(sb);
    if (probe.ok) {
      res.json({
        configured: true,
        clientReady: true,
        quests: { readable: true },
        questsUseServiceRole: !!config.supabase?.serviceRoleKey?.trim(),
      });
      return;
    }

    res.json({
      configured: true,
      clientReady: true,
      quests: {
        readable: false,
        error: probe.error,
        ...(probe.code ? { code: probe.code } : {}),
        ...(probe.hint ? { hint: probe.hint } : {}),
      },
      questsUseServiceRole: !!config.supabase?.serviceRoleKey?.trim(),
    });
  }));

  // --- Patyna quests (Supabase Auth user_id; same writes as `quest` tool) ---

  function pickBodyString(body: unknown, ...keys: string[]): string | undefined {
    if (!body || typeof body !== "object") return undefined;
    const o = body as Record<string, unknown>;
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  }

  function pickBodyBoolean(body: unknown, ...keys: string[]): boolean | undefined {
    if (!body || typeof body !== "object") return undefined;
    const o = body as Record<string, unknown>;
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "boolean") return v;
      if (v === 0 || v === 1) return v === 1;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true" || s === "1") return true;
        if (s === "false" || s === "0") return false;
      }
    }
    return undefined;
  }

  // POST /api/quests  -  create quest (Patyna aelora-client)
  app.post("/api/quests", async (req, res) => {
    const sb = requireQuestWriteSupabase(res);
    if (!sb) return;

    const body = req.body;
    const uidRaw = pickBodyString(
      body,
      "supabaseUserId",
      "supabase_user_id",
      "userId",
      "user_id",
    );
    const titleRaw = pickBodyString(body, "title", "name", "taskTitle", "task_title", "label");
    const description = pickBodyString(body, "description", "body", "details");
    const category = pickBodyString(body, "category");
    const difficulty = pickBodyString(body, "difficulty");
    const questType = pickBodyString(body, "quest_type", "questType");

    if (!uidRaw) {
      const ct = req.headers["content-type"] ?? "";
      console.warn(
        "Web: POST /api/quests missing user id (body keys:",
        body && typeof body === "object" ? Object.keys(body as object).join(", ") : typeof body,
        "content-type:",
        ct,
        ")",
      );
      res.status(400).json({
        error: "supabaseUserId is required (Supabase Auth user UUID).",
        hint:
          "Send a JSON body with Content-Type: application/json. " +
          "Accepted user id keys: supabaseUserId, userId, supabase_user_id.",
      });
      return;
    }
    if (!isValidUuid(uidRaw)) {
      res.status(400).json({
        error: "supabaseUserId must be a valid UUID",
        received: uidRaw.slice(0, 80),
      });
      return;
    }
    if (!titleRaw) {
      res.status(400).json({
        error: "title is required",
        hint: "Accepted keys: title, name, taskTitle, label.",
      });
      return;
    }

    const result = await createQuestRow(sb, uidRaw, {
      title: titleRaw,
      description,
      category,
      difficulty,
      quest_type: questType,
    });

    if (!result.ok) {
      jsonQuestFailure(res, result);
      return;
    }

    res.status(201).json(result.row);
  });

  // POST /api/quests/:questId/complete  -  mark complete (optional notes → quest_logs)
  app.post("/api/quests/:questId/complete", async (req, res) => {
    const sb = requireQuestWriteSupabase(res);
    if (!sb) return;

    const { questId } = req.params;
    const body = req.body;
    const uidRaw = pickBodyString(
      body,
      "supabaseUserId",
      "supabase_user_id",
      "userId",
      "user_id",
    );
    const notes = pickBodyString(body, "notes", "note", "message");

    if (!uidRaw) {
      res.status(400).json({
        error: "supabaseUserId is required (Supabase Auth user UUID).",
        hint: "JSON body; keys: supabaseUserId, userId, supabase_user_id.",
      });
      return;
    }
    const uid = uidRaw;
    if (!isValidUuid(uid)) {
      res.status(400).json({ error: "supabaseUserId must be a valid UUID", received: uid.slice(0, 80) });
      return;
    }
    if (!questId || !isValidUuid(questId)) {
      res.status(400).json({ error: "questId must be a valid UUID" });
      return;
    }

    const result = await completeQuestRow(sb, uid, questId, {
      notes: typeof notes === "string" ? notes : undefined,
    });

    if (!result.ok) {
      jsonQuestFailure(res, result, { success: false });
      return;
    }

    res.json({
      success: true,
      quest: result.row,
      logInserted: result.logInserted,
      ...(result.notesSaveError ? { notesSaveError: result.notesSaveError } : {}),
    });
  });

  // POST /api/quests/:questId/favorite  -  set is_favorite (TOP 3) for Patyna
  app.post("/api/quests/:questId/favorite", async (req, res) => {
    const sb = requireQuestWriteSupabase(res);
    if (!sb) return;

    const { questId } = req.params;
    const body = req.body;
    const uidRaw = pickBodyString(
      body,
      "supabaseUserId",
      "supabase_user_id",
      "userId",
      "user_id",
    );
    const favoriteRaw = pickBodyBoolean(body, "is_favorite", "isFavorite");

    if (!uidRaw) {
      res.status(400).json({
        error: "supabaseUserId is required (Supabase Auth user UUID).",
        hint: "JSON body; keys: supabaseUserId, userId, supabase_user_id.",
      });
      return;
    }
    if (!isValidUuid(uidRaw)) {
      res.status(400).json({ error: "supabaseUserId must be a valid UUID", received: uidRaw.slice(0, 80) });
      return;
    }
    if (!questId || !isValidUuid(questId)) {
      res.status(400).json({ error: "questId must be a valid UUID" });
      return;
    }
    if (favoriteRaw === undefined) {
      res.status(400).json({
        error: "is_favorite is required (boolean).",
        hint: "Send is_favorite: true | false in the JSON body (or isFavorite).",
      });
      return;
    }

    const result = await setQuestFavoriteRow(sb, uidRaw, questId, favoriteRaw);

    if (!result.ok) {
      jsonQuestFailure(res, result);
      return;
    }

    res.json({ quest: result.row });
  });

  // GET /api/quests  -  list quests for a user
  app.get("/api/quests", async (req, res) => {
    const sb = requireSupabaseForQuests(res);
    if (!sb) return;

    const uidRaw = pickBodyString(
      req.query,
      "supabaseUserId",
      "supabase_user_id",
      "userId",
      "user_id",
    );
    if (!uidRaw) {
      res.status(400).json({
        error: "supabaseUserId is required (Supabase Auth user UUID).",
        hint: "Query param: ?supabaseUserId=<uuid> (or userId, user_id).",
      });
      return;
    }
    if (!isValidUuid(uidRaw)) {
      res.status(400).json({ error: "supabaseUserId must be a valid UUID", received: uidRaw.slice(0, 80) });
      return;
    }

    const status = pickBodyString(req.query, "status") ?? "all";
    const limitRaw = pickBodyString(req.query, "limit");
    const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 100) : 50;

    const result = await listQuestRows(sb, uidRaw, { status, limit });

    if (!result.ok) {
      jsonQuestFailure(res, result);
      return;
    }

    res.json(result.rows);
  });

  // PUT|PATCH /api/quests/:questId  -  update a quest
  const updateQuestHandler: express.RequestHandler<{ questId: string }> = async (req, res) => {
    const sb = requireQuestWriteSupabase(res);
    if (!sb) return;

    const { questId } = req.params;
    const body = req.body;
    const uidRaw = pickBodyString(
      body,
      "supabaseUserId",
      "supabase_user_id",
      "userId",
      "user_id",
    );

    if (!uidRaw) {
      res.status(400).json({
        error: "supabaseUserId is required (Supabase Auth user UUID).",
        hint: "JSON body; keys: supabaseUserId, userId, supabase_user_id.",
      });
      return;
    }
    if (!isValidUuid(uidRaw)) {
      res.status(400).json({ error: "supabaseUserId must be a valid UUID", received: uidRaw.slice(0, 80) });
      return;
    }
    if (!questId || !isValidUuid(questId)) {
      res.status(400).json({ error: "questId must be a valid UUID" });
      return;
    }

    const title = pickBodyString(body, "title");
    const description = pickBodyString(body, "description", "body", "details");
    const category = pickBodyString(body, "category");
    const questType = pickBodyString(body, "quest_type", "questType");
    const status = pickBodyString(body, "status");
    const difficulty = pickBodyString(body, "difficulty");
    const suggestedBy = pickBodyString(body, "suggested_by", "suggestedBy");
    const isFavorite = pickBodyBoolean(body, "is_favorite", "isFavorite");

    const o = body as Record<string, unknown>;
    const targetValue = typeof o.target_value === "number" ? o.target_value
      : typeof o.targetValue === "number" ? o.targetValue : undefined;
    const currentValue = typeof o.current_value === "number" ? o.current_value
      : typeof o.currentValue === "number" ? o.currentValue : undefined;

    const result = await updateQuestRow(sb, uidRaw, questId, {
      title,
      description,
      category,
      quest_type: questType,
      target_value: targetValue,
      current_value: currentValue,
      status,
      difficulty,
      suggested_by: suggestedBy,
      is_favorite: isFavorite,
    });

    if (!result.ok) {
      jsonQuestFailure(res, result);
      return;
    }

    res.json({ quest: result.row });
  };
  app.put("/api/quests/:questId", updateQuestHandler);
  app.patch("/api/quests/:questId", updateQuestHandler);

  // DELETE /api/quests/:questId  -  delete a quest and its logs
  app.delete("/api/quests/:questId", async (req, res) => {
    const sb = requireQuestWriteSupabase(res);
    if (!sb) return;

    const { questId } = req.params;
    const uidRaw = pickBodyString(
      req.body,
      "supabaseUserId",
      "supabase_user_id",
      "userId",
      "user_id",
    ) ?? pickBodyString(
      req.query,
      "supabaseUserId",
      "supabase_user_id",
      "userId",
      "user_id",
    );

    if (!uidRaw) {
      res.status(400).json({
        error: "supabaseUserId is required (Supabase Auth user UUID).",
        hint: "JSON body or query param; keys: supabaseUserId, userId, supabase_user_id.",
      });
      return;
    }
    if (!isValidUuid(uidRaw)) {
      res.status(400).json({ error: "supabaseUserId must be a valid UUID", received: uidRaw.slice(0, 80) });
      return;
    }
    if (!questId || !isValidUuid(questId)) {
      res.status(400).json({ error: "questId must be a valid UUID" });
      return;
    }

    const result = await deleteQuestRow(sb, uidRaw, questId);

    if (!result.ok) {
      jsonQuestFailure(res, result);
      return;
    }

    res.json({ ok: true, id: result.id, title: result.title });
  });

  // --- Users ---

  // Users  -  list all profiles
  app.get("/api/users", (_req, res) => {
    res.json(getAllUsers());
  });

  // Users  -  get single profile with memory facts
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

  // Users  -  delete profile
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
      dyad: resolveDyad(mood.emotion, mood.secondary),
      note: mood.note ?? null,
      updatedAt: mood.updatedAt,
    });
  });

  // Current emotion as continuous vector (for 3D mesh clients)
  app.get("/api/emotion", (_req, res) => {
    const mood = loadMood();
    res.json(mood ? moodStateToVector(mood) : zeroVector());
  });

  // Set mood manually or trigger re-classification
  app.post("/api/mood", async (req, res) => {
    const { emotion, intensity, secondary, note, reclassify } = req.body ?? {};

    // Trigger a re-classify from the last bot response
    if (reclassify) {
      try {
        await classifyMood("(force reclassify)", "(force reclassify)");
        const mood = loadMood();
        res.json(mood ? { active: true, emotion: mood.emotion, intensity: mood.intensity, label: resolveLabel(mood) } : { active: false });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Manual mood set
    if (!emotion) {
      res.status(400).json({ error: "emotion is required (joy, trust, fear, surprise, sadness, disgust, anger, anticipation)" });
      return;
    }

    const { saveMood: save, PLUTCHIK_EMOTIONS } = await import("./mood.js");
    const validEmotions = Object.keys(PLUTCHIK_EMOTIONS);
    if (!validEmotions.includes(emotion)) {
      res.status(400).json({ error: `Invalid emotion. Must be one of: ${validEmotions.join(", ")}` });
      return;
    }

    const validIntensities = ["low", "mid", "high"];
    const int = intensity || "mid";
    if (!validIntensities.includes(int)) {
      res.status(400).json({ error: "intensity must be low, mid, or high" });
      return;
    }

    save({
      emotion,
      intensity: int,
      ...(secondary && validEmotions.includes(secondary) ? { secondary } : {}),
      ...(note ? { note: note.slice(0, 200) } : {}),
      updatedAt: new Date().toISOString(),
    });

    const mood = loadMood();
    res.json({ active: true, emotion: mood!.emotion, intensity: mood!.intensity, label: resolveLabel(mood!) });
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

  // --- Linear ---

  function getLinearApiKey(): string | null {
    const tools = config.tools as Record<string, Record<string, unknown>> | undefined;
    const linear = tools?.["linear"] as Record<string, string> | undefined;
    return linear?.apiKey || null;
  }

  function requireLinear(res: express.Response): LinearClient | null {
    const apiKey = getLinearApiKey();
    if (!apiKey) {
      res.status(503).json({ error: "Linear not configured. Add linear.apiKey to settings.yaml under tools:" });
      return null;
    }
    return new LinearClient({ apiKey });
  }

  // GET /api/linear/teams
  app.get("/api/linear/teams", async (_req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const teams = await client.teams({ first: 50 });
      res.json(teams.nodes.map(t => ({ id: t.id, name: t.name, key: t.key, description: t.description })));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/linear/projects
  app.get("/api/linear/projects", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
      const projects = await client.projects({ first: limit });
      res.json(projects.nodes.map(p => ({
        id: p.id, name: p.name, state: p.state,
        progress: p.progress != null ? Math.round(p.progress * 100) : null,
        description: p.description,
      })));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/linear/issues
  app.get("/api/linear/issues", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
      const filter: Record<string, unknown> = {};
      if (req.query.team) filter.team = { key: { eq: req.query.team } };
      if (req.query.status) filter.state = { name: { eq: req.query.status } };
      if (req.query.since) filter.updatedAt = { gte: new Date(req.query.since as string) };

      const issues = await client.issues({
        first: limit,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
      });

      const result = [];
      for (const issue of issues.nodes) {
        const state = await issue.state;
        const assignee = await issue.assignee;
        result.push({
          id: issue.id, identifier: issue.identifier, title: issue.title,
          status: state?.name ?? null, priority: issue.priority,
          assignee: assignee ? { name: assignee.name, email: assignee.email } : null,
          dueDate: issue.dueDate ?? null, estimate: issue.estimate ?? null,
          createdAt: issue.createdAt, updatedAt: issue.updatedAt,
        });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/linear/issues/me
  app.get("/api/linear/issues/me", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
      const me = await client.viewer;
      const filter: Record<string, unknown> = {};
      if (req.query.status) filter.state = { name: { eq: req.query.status } };
      const assigned = await me.assignedIssues({
        first: limit,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
      });

      const result = [];
      for (const issue of assigned.nodes) {
        const state = await issue.state;
        result.push({
          id: issue.id, identifier: issue.identifier, title: issue.title,
          status: state?.name ?? null, priority: issue.priority,
          dueDate: issue.dueDate ?? null, estimate: issue.estimate ?? null,
        });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/linear/issues/:id
  app.get("/api/linear/issues/:id", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const issue = await client.issue(req.params.id);
      const state = await issue.state;
      const assignee = await issue.assignee;
      const proj = await issue.project;
      const labels = await issue.labels();
      const comments = await issue.comments({ first: 10 });

      const commentData = [];
      for (const c of comments.nodes) {
        const author = await c.user;
        commentData.push({ author: author?.name ?? "Unknown", body: c.body, createdAt: c.createdAt });
      }

      res.json({
        id: issue.id, identifier: issue.identifier, title: issue.title,
        description: issue.description ?? null,
        status: state?.name ?? null, priority: issue.priority,
        assignee: assignee ? { name: assignee.name, email: assignee.email } : null,
        project: proj ? { name: proj.name, id: proj.id } : null,
        labels: labels.nodes.map(l => l.name),
        dueDate: issue.dueDate ?? null, estimate: issue.estimate ?? null,
        createdAt: issue.createdAt, updatedAt: issue.updatedAt,
        comments: commentData,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/linear/issues/:id/sub-issues
  app.get("/api/linear/issues/:id/sub-issues", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const parent = await client.issue(req.params.id);
      const children = await parent.children({ first: 50 });

      const result = [];
      for (const issue of children.nodes) {
        const state = await issue.state;
        const assignee = await issue.assignee;
        result.push({
          id: issue.id, identifier: issue.identifier, title: issue.title,
          status: state?.name ?? null, priority: issue.priority,
          assignee: assignee?.name ?? null,
          dueDate: issue.dueDate ?? null,
        });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/linear/issues
  app.post("/api/linear/issues", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const { team, title, description, priority, dueDate, estimate, assigneeEmail, status, labels, project, parentIssueId } = req.body;
      if (!title) return res.status(400).json({ error: "title is required" });
      if (!team) return res.status(400).json({ error: "team is required" });

      const teams = await client.teams({ filter: { key: { eq: team } } });
      const teamNode = teams.nodes[0];
      if (!teamNode) return res.status(404).json({ error: `Team '${team}' not found` });

      const input: Record<string, unknown> = { teamId: teamNode.id, title };
      if (description) input.description = description;
      if (priority != null) input.priority = priority;
      if (dueDate) input.dueDate = dueDate;
      if (estimate != null) input.estimate = estimate;
      if (parentIssueId) {
        const parent = await client.issue(parentIssueId);
        input.parentId = parent.id;
      }

      if (assigneeEmail) {
        const users = await client.users();
        const match = users.nodes.find(u => u.email === assigneeEmail);
        if (!match) return res.status(404).json({ error: `No user with email '${assigneeEmail}'` });
        input.assigneeId = match.id;
      }
      if (status) {
        const states = await client.workflowStates({ filter: { team: { id: { eq: teamNode.id } }, name: { eq: status } } });
        if (states.nodes[0]) input.stateId = states.nodes[0].id;
      }
      if (labels && Array.isArray(labels) && labels.length > 0) {
        const allLabels = await client.issueLabels({ filter: { team: { id: { eq: teamNode.id } } } });
        const nameSet = new Set(labels.map((n: string) => n.toLowerCase()));
        const ids = allLabels.nodes.filter(l => nameSet.has(l.name.toLowerCase())).map(l => l.id);
        if (ids.length > 0) input.labelIds = ids;
      }
      if (project) {
        const projects = await client.projects({ filter: { name: { eq: project } } });
        if (projects.nodes[0]) input.projectId = projects.nodes[0].id;
      }

      const result = await client.createIssue(input as Parameters<typeof client.createIssue>[0]);
      const created = await result.issue;
      if (!created) return res.status(500).json({ error: "Failed to create issue" });

      res.status(201).json({ identifier: created.identifier, title: created.title, id: created.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PATCH /api/linear/issues/:id
  app.patch("/api/linear/issues/:id", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const issue = await client.issue(req.params.id);
      const teamRef = await issue.team;
      const { title, description, priority, dueDate, estimate, assigneeEmail, status, labels, project } = req.body;

      const input: Record<string, unknown> = {};
      if (title) input.title = title;
      if (description) input.description = description;
      if (priority != null) input.priority = priority;
      if (dueDate) input.dueDate = dueDate;
      if (estimate != null) input.estimate = estimate;

      if (assigneeEmail) {
        const users = await client.users();
        const match = users.nodes.find(u => u.email === assigneeEmail);
        if (!match) return res.status(404).json({ error: `No user with email '${assigneeEmail}'` });
        input.assigneeId = match.id;
      }
      if (status && teamRef) {
        const states = await client.workflowStates({ filter: { team: { id: { eq: teamRef.id } }, name: { eq: status } } });
        if (states.nodes[0]) input.stateId = states.nodes[0].id;
      }
      if (labels && Array.isArray(labels) && labels.length > 0 && teamRef) {
        const allLabels = await client.issueLabels({ filter: { team: { id: { eq: teamRef.id } } } });
        const nameSet = new Set(labels.map((n: string) => n.toLowerCase()));
        const ids = allLabels.nodes.filter(l => nameSet.has(l.name.toLowerCase())).map(l => l.id);
        if (ids.length > 0) input.labelIds = ids;
      }
      if (project) {
        const projects = await client.projects({ filter: { name: { eq: project } } });
        if (projects.nodes[0]) input.projectId = projects.nodes[0].id;
      }

      if (Object.keys(input).length === 0) return res.status(400).json({ error: "No fields to update" });

      await client.updateIssue(issue.id, input);
      const updated = await client.issue(req.params.id);
      const newState = await updated.state;

      res.json({ identifier: updated.identifier, title: updated.title, status: newState?.name ?? null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/linear/issues/:id
  app.delete("/api/linear/issues/:id", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const issue = await client.issue(req.params.id);
      const identifier = issue.identifier;
      await client.deleteIssue(issue.id);
      res.json({ deleted: identifier });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/linear/issues/:id/comments
  app.post("/api/linear/issues/:id/comments", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const { body } = req.body;
      if (!body) return res.status(400).json({ error: "body is required" });

      const issue = await client.issue(req.params.id);
      await client.createComment({ issueId: issue.id, body });
      res.status(201).json({ identifier: issue.identifier, commented: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/linear/search
  app.get("/api/linear/search", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const query = req.query.q as string;
      if (!query) return res.status(400).json({ error: "q query parameter is required" });
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 25));

      const results = await client.searchIssues(query, { first: limit });
      const result = [];
      for (const issue of results.nodes) {
        const state = await issue.state;
        const assignee = await issue.assignee;
        result.push({
          id: issue.id, identifier: issue.identifier, title: issue.title,
          status: state?.name ?? null, priority: issue.priority,
          assignee: assignee?.name ?? null,
          dueDate: issue.dueDate ?? null,
        });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/linear/projects
  app.post("/api/linear/projects", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const { name, team, description, content, status: projStatus } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });
      if (!team) return res.status(400).json({ error: "team is required" });

      const teams = await client.teams({ filter: { key: { eq: team } } });
      const teamNode = teams.nodes[0];
      if (!teamNode) return res.status(404).json({ error: `Team '${team}' not found` });

      const input: Record<string, unknown> = { name, teamIds: [teamNode.id] };
      if (description) input.description = description;
      if (content) input.content = content;
      if (projStatus) input.state = projStatus;

      const result = await client.createProject(input as Parameters<typeof client.createProject>[0]);
      const created = await result.project;
      if (!created) return res.status(500).json({ error: "Failed to create project" });

      res.status(201).json({ id: created.id, name: created.name, state: created.state });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PATCH /api/linear/projects/:name
  app.patch("/api/linear/projects/:name", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const projects = await client.projects({ filter: { name: { eq: req.params.name } } });
      const proj = projects.nodes[0];
      if (!proj) return res.status(404).json({ error: `Project '${req.params.name}' not found` });

      const { name, description, content, status: projStatus, targetDate } = req.body;
      const input: Record<string, unknown> = {};
      if (name) input.name = name;
      if (description) input.description = description;
      if (content) input.content = content;
      if (projStatus) input.state = projStatus;
      if (targetDate) input.targetDate = targetDate;

      if (Object.keys(input).length === 0) return res.status(400).json({ error: "No fields to update" });

      await client.updateProject(proj.id, input);
      res.json({ name: name ?? req.params.name, updated: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/linear/projects/:name/updates
  app.post("/api/linear/projects/:name/updates", async (req, res) => {
    const client = requireLinear(res);
    if (!client) return;
    try {
      const projects = await client.projects({ filter: { name: { eq: req.params.name } } });
      const proj = projects.nodes[0];
      if (!proj) return res.status(404).json({ error: `Project '${req.params.name}' not found` });

      const { body, health } = req.body;
      if (!body) return res.status(400).json({ error: "body is required" });

      const input: Record<string, unknown> = { projectId: proj.id, body };
      if (health && ["onTrack", "atRisk", "offTrack"].includes(health)) input.health = health;

      await client.createProjectUpdate(input as Parameters<typeof client.createProjectUpdate>[0]);
      res.status(201).json({ project: req.params.name, health: health ?? null, posted: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Data export ---

  app.get("/api/export", asyncHandler(async (req, res) => {
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

    const payload = JSON.stringify(bundle);
    const payloadBytes = Buffer.byteLength(payload, "utf-8");
    if (payloadBytes > MAX_EXPORT_BYTES) {
      res.status(413).json({
        error: `Export payload too large (${payloadBytes} bytes). Limit is ${MAX_EXPORT_BYTES} bytes.`,
      });
      return;
    }

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename=aelora-export-${date}.json`);
    res.type("application/json").send(payload);
  }));

  // --- Ambient awareness ---

  app.get("/api/ambient/status", async (_req, res) => {
    try {
      const { getAmbientState } = await import("./ambient/engine.js");
      res.json(getAmbientState());
    } catch {
      res.json({ enabled: false, triggers: [], bufferStats: [], globalSendsLastHour: 0, globalRateLimitPerHour: 6, evaluationIntervalMs: 300000 });
    }
  });

  app.get("/api/ambient/buffers", async (_req, res) => {
    try {
      const { getBufferStats } = await import("./ambient/buffer.js");
      res.json(getBufferStats());
    } catch {
      res.json([]);
    }
  });

  app.post("/api/ambient/triggers/:name/toggle", async (req, res) => {
    try {
      const { toggleTrigger } = await import("./ambient/engine.js");
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled (boolean) required" });
        return;
      }
      const ok = toggleTrigger(req.params.name, enabled);
      if (!ok) {
        res.status(404).json({ error: `trigger "${req.params.name}" not found` });
        return;
      }
      res.json({ name: req.params.name, enabled });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Global error handler — catches unhandled errors from any route
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const requestId = res.locals.requestId ?? "no-id";
    console.error(`Web: [${requestId}] Unhandled error in ${req.method} ${req.path}: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error", requestId });
    }
  });

  const server = createServer(app);
  server.listen(config.web.port, "0.0.0.0", () => {
    console.log(`Web: dashboard at http://0.0.0.0:${config.web.port}${basePath}/dashboard`);
  });
  return server;
}

import { appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Response } from "express";
import type { WebSocket } from "ws";

type LogEntry = {
  ts: string;
  level: "log" | "warn" | "error";
  message: string;
};

let maxBuffer = 200;
let fileEnabled = false;
let retainDays = 7;
const LOG_DIR = "data/logs";

const buffer: LogEntry[] = [];

/** Apply config overrides. Call after config is loaded. */
export function configureLogger(opts: { maxBuffer?: number; fileEnabled?: boolean; retainDays?: number }): void {
  if (opts.maxBuffer) maxBuffer = opts.maxBuffer;
  if (opts.fileEnabled !== undefined) fileEnabled = opts.fileEnabled;
  if (opts.retainDays) retainDays = opts.retainDays;

  if (fileEnabled) {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    rotateLogFiles();
  }
}

const sseClients = new Set<Response>();
const wsClients = new Set<WebSocket>();

// Store originals
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

const LEVEL_TAG: Record<LogEntry["level"], string> = {
  log: "INFO",
  warn: "WARN",
  error: "ERROR",
};

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${date}.log`);
}

function writeToFile(entry: LogEntry): void {
  if (!fileEnabled) return;
  try {
    const line = `[${entry.ts}] [${LEVEL_TAG[entry.level]}] ${entry.message}\n`;
    appendFileSync(getLogFilePath(), line, "utf-8");
  } catch {
    // Don't recurse into console.error — use origError
    origError("Logger: failed to write to log file");
  }
}

function rotateLogFiles(): void {
  try {
    if (!existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(LOG_DIR).filter((f) => f.endsWith(".log"));

    for (const file of files) {
      // Parse date from filename (YYYY-MM-DD.log)
      const dateStr = file.replace(".log", "");
      const fileDate = new Date(dateStr + "T00:00:00Z").getTime();
      if (!Number.isNaN(fileDate) && fileDate < cutoff) {
        unlinkSync(path.join(LOG_DIR, file));
        origLog(`Logger: rotated old log file ${file}`);
      }
    }
  } catch {
    origError("Logger: failed to rotate log files");
  }
}

function push(level: LogEntry["level"], args: unknown[]): void {
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const entry: LogEntry = { ts: new Date().toISOString(), level, message };

  buffer.push(entry);
  if (buffer.length > maxBuffer) buffer.shift();

  writeToFile(entry);

  // Broadcast to all SSE clients
  const data = JSON.stringify(entry);
  for (const res of sseClients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

/** Install console overrides. Call once at startup before anything logs. */
export function installLogger(): void {
  console.log = (...args: unknown[]) => {
    origLog.apply(console, args);
    push("log", args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args);
    push("warn", args);
  };
  console.error = (...args: unknown[]) => {
    origError.apply(console, args);
    push("error", args);
  };
}

/** Get recent log entries (for initial load). */
export function getRecentLogs(): LogEntry[] {
  return [...buffer];
}

/** Register an SSE client response. */
export function addSSEClient(res: Response): void {
  sseClients.add(res);
  res.on("close", () => sseClients.delete(res));
}

/** Register a WebSocket client for live event broadcasts. */
export function addWSClient(ws: WebSocket): void {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
}

/** Send a named SSE event to all connected clients (SSE + WebSocket). */
export function broadcastEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }

  const wsPayload = JSON.stringify({ type: "event", event, data });
  for (const ws of wsClients) {
    try {
      ws.send(wsPayload);
    } catch {
      wsClients.delete(ws);
    }
  }
}

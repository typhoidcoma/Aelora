import type { Response } from "express";
import type { WebSocket } from "ws";

type LogEntry = {
  ts: string;
  level: "log" | "warn" | "error";
  message: string;
};

const MAX_BUFFER = 200;
const buffer: LogEntry[] = [];
const sseClients = new Set<Response>();
const wsClients = new Set<WebSocket>();

// Store originals
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function push(level: LogEntry["level"], args: unknown[]): void {
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const entry: LogEntry = { ts: new Date().toISOString(), level, message };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

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

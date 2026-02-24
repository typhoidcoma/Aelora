import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { Config } from "./config.js";
import { getLLMResponse, clearHistory } from "./llm.js";
import { recordMessage } from "./sessions.js";
import { classifyMood } from "./mood.js";
import { appendLog } from "./daily-log.js";
import { updateUser } from "./users.js";
import { addWSClient } from "./logger.js";

// ============================================================
// Types
// ============================================================

type ClientMessage =
  | { type: "init"; sessionId: string; userId?: string; username?: string }
  | { type: "message"; content: string }
  | { type: "clear" };

type ServerMessage =
  | { type: "ready"; sessionId: string }
  | { type: "token"; content: string }
  | { type: "done"; reply: string }
  | { type: "error"; error: string }
  | { type: "event"; event: string; data: unknown };

type ClientState = {
  sessionId: string | null;
  userId: string | null;
  username: string | null;
  busy: boolean;
};

// ============================================================
// Helpers
// ============================================================

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ============================================================
// WebSocket server
// ============================================================

const clients = new Set<WebSocket>();

const PING_INTERVAL = 30_000;

export function startWebSocket(server: Server, config: Config): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Heartbeat to detect stale connections
  const interval = setInterval(() => {
    for (const ws of clients) {
      if ((ws as any).__alive === false) {
        ws.terminate();
        continue;
      }
      (ws as any).__alive = false;
      ws.ping();
    }
  }, PING_INTERVAL);

  wss.on("close", () => clearInterval(interval));

  wss.on("connection", (ws, req) => {
    // Auth check
    if (config.web.apiKey) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const token = url.searchParams.get("token");
      if (token !== config.web.apiKey) {
        send(ws, { type: "error", error: "Unauthorized. Connect with ?token=API_KEY." });
        ws.close(4001, "Unauthorized");
        return;
      }
    }

    clients.add(ws);
    (ws as any).__alive = true;

    // Register for live event broadcasts (mood, etc.)
    addWSClient(ws);

    const state: ClientState = {
      sessionId: null,
      userId: null,
      username: null,
      busy: false,
    };

    ws.on("pong", () => { (ws as any).__alive = true; });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });

    ws.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", error: "Invalid JSON." });
        return;
      }

      switch (msg.type) {
        // ---- Init: bind session ----
        case "init": {
          if (!msg.sessionId) {
            send(ws, { type: "error", error: "sessionId is required for init." });
            return;
          }
          state.sessionId = msg.sessionId;
          state.userId = msg.userId ?? null;
          state.username = msg.username ?? null;
          send(ws, { type: "ready", sessionId: state.sessionId });
          console.log(`WS: client init session=${state.sessionId} user=${state.username ?? "anonymous"}`);
          break;
        }

        // ---- Message: run LLM pipeline ----
        case "message": {
          if (!state.sessionId) {
            send(ws, { type: "error", error: "Send init first." });
            return;
          }
          if (!msg.content) {
            send(ws, { type: "error", error: "content is required." });
            return;
          }
          if (state.busy) {
            send(ws, { type: "error", error: "Still processing previous message." });
            return;
          }

          state.busy = true;

          // Track session and user
          if (state.userId && state.username) {
            recordMessage({
              channelId: state.sessionId,
              guildId: null,
              channelName: state.sessionId,
              userId: state.userId,
              username: state.username,
            });
            updateUser(state.userId, state.username, state.sessionId);
          }

          try {
            const reply = await getLLMResponse(
              state.sessionId,
              msg.content,
              (token) => send(ws, { type: "token", content: token }),
              state.userId ?? undefined,
            );

            send(ws, { type: "done", reply });

            // Side effects (async, best-effort)
            appendLog({
              channelName: state.sessionId,
              userId: state.userId ?? "anonymous",
              username: state.username ?? "anonymous",
              summary: `**User:** ${msg.content.slice(0, 200)}\n**Bot:** ${reply.slice(0, 200)}`,
            });
            classifyMood(reply, msg.content).catch(() => {});
          } catch (err) {
            send(ws, { type: "error", error: String(err) });
          } finally {
            state.busy = false;
          }
          break;
        }

        // ---- Clear: reset session history ----
        case "clear": {
          if (!state.sessionId) {
            send(ws, { type: "error", error: "Send init first." });
            return;
          }
          clearHistory(state.sessionId);
          send(ws, { type: "ready", sessionId: state.sessionId });
          console.log(`WS: cleared history for session=${state.sessionId}`);
          break;
        }

        default:
          send(ws, { type: "error", error: `Unknown message type "${(msg as any).type}".` });
      }
    });
  });

  console.log("WS: WebSocket server attached on /ws");
}

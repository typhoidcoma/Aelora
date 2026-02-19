import type { Config } from "./config.js";

export type HeartbeatContext = {
  sendToChannel: (channelId: string, text: string) => Promise<void>;
  llmOneShot: (prompt: string) => Promise<string>;
  config: Config;
};

export type HeartbeatHandler = {
  name: string;
  description: string;
  enabled: boolean;
  execute: (ctx: HeartbeatContext) => Promise<void>;
};

export type HeartbeatState = {
  running: boolean;
  intervalMs: number;
  lastTick: Date | null;
  tickCount: number;
  handlers: HeartbeatHandler[];
};

let timer: ReturnType<typeof setInterval> | null = null;

const state: HeartbeatState = {
  running: false,
  intervalMs: 60_000,
  lastTick: null,
  tickCount: 0,
  handlers: [],
};

let context: HeartbeatContext | null = null;

export function registerHeartbeatHandler(handler: HeartbeatHandler): void {
  state.handlers.push(handler);
  console.log(
    `Heartbeat: registered handler "${handler.name}" (${handler.enabled ? "enabled" : "disabled"})`,
  );
}

export function startHeartbeat(config: Config, ctx: HeartbeatContext): void {
  if (timer) {
    console.warn("Heartbeat: already running");
    return;
  }

  context = ctx;
  state.intervalMs = config.heartbeat.intervalMs;
  state.running = true;

  console.log(
    `Heartbeat: starting (${state.intervalMs / 1000}s interval, ${state.handlers.length} handler(s))`,
  );

  timer = setInterval(async () => {
    state.lastTick = new Date();
    state.tickCount++;

    for (const handler of state.handlers) {
      if (!handler.enabled) continue;

      try {
        await handler.execute(context!);
      } catch (err) {
        console.error(`Heartbeat [${handler.name}] error:`, err);
      }
    }
  }, state.intervalMs);
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    state.running = false;
    console.log("Heartbeat: stopped");
  }
}

export function getHeartbeatState(): {
  running: boolean;
  intervalMs: number;
  lastTick: string | null;
  tickCount: number;
  handlers: { name: string; description: string; enabled: boolean }[];
} {
  return {
    running: state.running,
    intervalMs: state.intervalMs,
    lastTick: state.lastTick?.toISOString() ?? null,
    tickCount: state.tickCount,
    handlers: state.handlers.map((h) => ({
      name: h.name,
      description: h.description,
      enabled: h.enabled,
    })),
  };
}

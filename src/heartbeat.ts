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
  /** Return a string to log what was done, or void/undefined for silent ticks. */
  execute: (ctx: HeartbeatContext) => Promise<string | void>;
};

/** Per-handler execution record — populated on each tick for dashboard visibility. */
type HandlerRun = {
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastResult: string | null;
  lastError: string | null;
  runCount: number;
  errorCount: number;
};

export type HeartbeatState = {
  running: boolean;
  intervalMs: number;
  lastTick: Date | null;
  tickCount: number;
  handlers: HeartbeatHandler[];
};

const handlerRuns = new Map<string, HandlerRun>();

function ensureRunRecord(name: string): HandlerRun {
  let rec = handlerRuns.get(name);
  if (!rec) {
    rec = { lastRunAt: null, lastDurationMs: null, lastResult: null, lastError: null, runCount: 0, errorCount: 0 };
    handlerRuns.set(name, rec);
  }
  return rec;
}

// Hard cap on a single handler invocation. Anything longer is treated as a
// hang and abandoned (the handler keeps running in the background but stops
// blocking the tick). 60s is generous: the slowest handler today is the KB
// Drive sync, which is itself self-throttled and runs in chunks.
const HANDLER_TIMEOUT_MS = 60_000;

function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(`heartbeat handler "${label}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (err) => {
        clearTimeout(handle);
        reject(err);
      },
    );
  });
}

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

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
  if (timer || startupTimer) {
    console.warn("Heartbeat: already running");
    return;
  }

  context = ctx;
  state.intervalMs = config.heartbeat.intervalMs;
  state.running = true;

  console.log(
    `Heartbeat: starting (${state.intervalMs / 1000}s interval, ${state.handlers.length} handler(s))`,
  );

  const runTick = async (): Promise<void> => {
    state.lastTick = new Date();
    state.tickCount++;

    // Run handlers in parallel so one slow handler can't delay the rest, and
    // wrap each in a hard timeout so a hung Drive/LLM call can't stall the
    // whole loop. Failures are logged per-handler; one bad apple never blocks
    // the next tick from running.
    const enabled = state.handlers.filter((h) => h.enabled);
    await Promise.allSettled(
      enabled.map(async (handler) => {
        const handlerStart = Date.now();
        const rec = ensureRunRecord(handler.name);
        try {
          const result = await runWithTimeout(
            handler.execute(context!),
            HANDLER_TIMEOUT_MS,
            handler.name,
          );
          const elapsed = Date.now() - handlerStart;
          rec.lastRunAt = new Date().toISOString();
          rec.lastDurationMs = elapsed;
          rec.lastResult = typeof result === "string" ? result : null;
          rec.lastError = null;
          rec.runCount++;
          if (result) console.log(`Heartbeat: [${handler.name}] ${result} (${elapsed}ms)`);
        } catch (err) {
          const elapsed = Date.now() - handlerStart;
          rec.lastRunAt = new Date().toISOString();
          rec.lastDurationMs = elapsed;
          rec.lastError = err instanceof Error ? err.message : String(err);
          rec.lastResult = null;
          rec.errorCount++;
          console.error(`Heartbeat: [${handler.name}] error after ${elapsed}ms:`, err);
        }
      }),
    );
  };

  const jitterMs = Math.min(Math.floor(state.intervalMs / 4), 30_000);
  const initialDelay = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runTick();
    timer = setInterval(() => {
      void runTick();
    }, state.intervalMs);
  }, initialDelay);
}

export function stopHeartbeat(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
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
  handlers: {
    name: string;
    description: string;
    enabled: boolean;
    lastRunAt: string | null;
    lastDurationMs: number | null;
    lastResult: string | null;
    lastError: string | null;
    runCount: number;
    errorCount: number;
  }[];
} {
  return {
    running: state.running,
    intervalMs: state.intervalMs,
    lastTick: state.lastTick?.toISOString() ?? null,
    tickCount: state.tickCount,
    handlers: state.handlers.map((h) => {
      const rec = handlerRuns.get(h.name);
      return {
        name: h.name,
        description: h.description,
        enabled: h.enabled,
        lastRunAt: rec?.lastRunAt ?? null,
        lastDurationMs: rec?.lastDurationMs ?? null,
        lastResult: rec?.lastResult ?? null,
        lastError: rec?.lastError ?? null,
        runCount: rec?.runCount ?? 0,
        errorCount: rec?.errorCount ?? 0,
      };
    }),
  };
}

import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type ReplaceEntry = {
  mode: "replace";
  content: string;
  atomic: boolean;
};

type AppendEntry = {
  mode: "append";
  chunks: string[];
};

type QueueEntry = {
  filePath: string;
  debounceMs: number;
  touchedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  pending: ReplaceEntry | AppendEntry | null;
};

type AsyncWriteStats = {
  queuedFiles: number;
  queuedBytes: number;
  flushFailures: number;
};

const queue = new Map<string, QueueEntry>();
const failureCounts = new Map<string, number>();
const warnCooldown = new Map<string, number>();

const FORCE_FLUSH_MS = 5_000;
const WARN_COOLDOWN_MS = 30_000;

let forceFlushTimer: ReturnType<typeof setInterval> | null = null;
let flushFailures = 0;

function ensureForceFlushTimer(): void {
  if (forceFlushTimer) return;
  forceFlushTimer = setInterval(() => {
    const now = Date.now();
    for (const entry of queue.values()) {
      if (!entry.pending || entry.flushing) continue;
      if (now - entry.touchedAt >= FORCE_FLUSH_MS) {
        void flushFileQueue(entry.filePath);
      }
    }
  }, 1_000);
}

function maybeWarn(filePath: string, err: unknown): void {
  const now = Date.now();
  const last = warnCooldown.get(filePath) ?? 0;
  if (now - last < WARN_COOLDOWN_MS) return;
  warnCooldown.set(filePath, now);

  const count = failureCounts.get(filePath) ?? 0;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`AsyncWriteQueue: write failure for ${filePath} (count=${count}) - ${msg}`);
}

function clearTimer(entry: QueueEntry): void {
  if (!entry.timer) return;
  clearTimeout(entry.timer);
  entry.timer = null;
}

function schedule(entry: QueueEntry): void {
  clearTimer(entry);
  entry.timer = setTimeout(() => {
    void flushFileQueue(entry.filePath);
  }, entry.debounceMs);
}

function getOrCreateEntry(filePath: string, debounceMs: number): QueueEntry {
  let entry = queue.get(filePath);
  if (!entry) {
    entry = {
      filePath,
      debounceMs,
      touchedAt: Date.now(),
      timer: null,
      flushing: false,
      pending: null,
    };
    queue.set(filePath, entry);
  }

  entry.debounceMs = debounceMs;
  entry.touchedAt = Date.now();
  ensureForceFlushTimer();
  return entry;
}

async function writeSnapshot(filePath: string, snapshot: ReplaceEntry | AppendEntry): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  if (snapshot.mode === "append") {
    if (snapshot.chunks.length === 0) return;
    await appendFile(filePath, snapshot.chunks.join(""), "utf-8");
    return;
  }

  if (!snapshot.atomic) {
    await writeFile(filePath, snapshot.content, "utf-8");
    return;
  }

  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, snapshot.content, "utf-8");
  await rename(tmpPath, filePath);
}

export function queueTextWrite(
  filePath: string,
  content: string,
  opts?: { debounceMs?: number; atomic?: boolean },
): void {
  const entry = getOrCreateEntry(filePath, opts?.debounceMs ?? 200);

  if (entry.pending?.mode === "append") {
    // Preserve append ordering before switching to replace mode.
    void flushFileQueue(filePath);
  }

  entry.pending = {
    mode: "replace",
    content,
    atomic: opts?.atomic ?? false,
  };

  schedule(entry);
}

export function queueTextAppend(
  filePath: string,
  chunk: string,
  opts?: { debounceMs?: number },
): void {
  const entry = getOrCreateEntry(filePath, opts?.debounceMs ?? 500);

  if (entry.pending?.mode !== "append") {
    if (entry.pending?.mode === "replace") {
      // Preserve replace ordering before switching to append mode.
      void flushFileQueue(filePath);
    }
    entry.pending = { mode: "append", chunks: [] };
  }

  entry.pending.chunks.push(chunk);
  schedule(entry);
}

export async function flushFileQueue(filePath: string): Promise<void> {
  const entry = queue.get(filePath);
  if (!entry || !entry.pending || entry.flushing) return;

  entry.flushing = true;
  clearTimer(entry);

  const snapshot = entry.pending;
  entry.pending = null;

  try {
    await writeSnapshot(filePath, snapshot);
    failureCounts.delete(filePath);
  } catch (err) {
    flushFailures++;
    const count = (failureCounts.get(filePath) ?? 0) + 1;
    failureCounts.set(filePath, count);
    maybeWarn(filePath, err);

    // Requeue failed writes so data is not dropped.
    const pendingNow = queue.get(filePath)?.pending;
    if (!pendingNow) {
      entry.pending = snapshot;
    } else if (pendingNow.mode === "append" && snapshot.mode === "append") {
      pendingNow.chunks.unshift(...snapshot.chunks);
    }
    schedule(entry);
  } finally {
    entry.flushing = false;

    if (!entry.pending && !entry.timer) {
      queue.delete(filePath);
      if (queue.size === 0 && forceFlushTimer) {
        clearInterval(forceFlushTimer);
        forceFlushTimer = null;
      }
    }
  }
}

export async function flushAllQueuedWrites(): Promise<void> {
  const paths = [...queue.keys()];
  await Promise.all(paths.map((p) => flushFileQueue(p)));
}

export function getAsyncWriteStats(): AsyncWriteStats {
  let queuedBytes = 0;
  for (const entry of queue.values()) {
    const pending = entry.pending;
    if (!pending) continue;
    if (pending.mode === "replace") {
      queuedBytes += Buffer.byteLength(pending.content, "utf-8");
    } else {
      queuedBytes += pending.chunks.reduce((sum, c) => sum + Buffer.byteLength(c, "utf-8"), 0);
    }
  }

  return {
    queuedFiles: queue.size,
    queuedBytes,
    flushFailures,
  };
}

/**
 * State persistence — saves shutdown context to disk so the next startup
 * knows what happened (clean shutdown, reboot, crash) and can report it.
 *
 * Also handles calendar reminder dedup persistence.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";

const STATE_FILE = "data/state.json";
const LAST_ALIVE_FILE = "data/last-alive.json";
const CALENDAR_NOTIFIED_FILE = "data/calendar-notified.json";
const REPLY_CHECKED_FILE = "data/reply-checked.json";
const ACTIVE_PERSONA_FILE = "data/active-persona.json";
const TOGGLE_STATE_FILE = "data/toggle-state.json";

export type ShutdownReason = "clean" | "reboot" | "crash" | "fatal";

export type StateFile = {
  timestamp: string;
  reason: ShutdownReason;
  uptimeSeconds: number;
  error?: string;
};

// ── Shutdown state ──────────────────────────────────────────────

/** Save shutdown state to disk. Fully synchronous — safe in signal handlers. */
export function saveState(reason: ShutdownReason, error?: string): void {
  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });

    // If a state file already exists, preserve the original timestamp.
    // This prevents startup crash loops from resetting the downtime clock.
    let originalTimestamp: string | undefined;
    if (existsSync(STATE_FILE)) {
      try {
        const existing: StateFile = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
        originalTimestamp = existing.timestamp;
      } catch {
        // Corrupted file — fall through with fresh timestamp
      }
    }

    const state: StateFile = {
      timestamp: originalTimestamp ?? new Date().toISOString(),
      reason,
      uptimeSeconds: Math.floor(process.uptime()),
      ...(error ? { error: error.slice(0, 2000) } : {}),
    };

    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
    console.log(`State: saved shutdown context (reason=${reason})`);
  } catch (err) {
    console.warn("State: failed to save shutdown context:", err);
  }
}

/** Read and delete previous state. Returns null on first boot or after clean consume. */
export function consumePreviousState(): StateFile | null {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, "utf-8");
      unlinkSync(STATE_FILE);
      const prev: StateFile = JSON.parse(raw);
      console.log(`State: restored previous state (reason=${prev.reason})`);
      clearLastAlive();
      return prev;
    }

    // No state file — check for a last-alive timestamp as fallback.
    // Covers force-kill scenarios (Task Manager, power loss) where no
    // signal handler ran and no state file was written.
    if (existsSync(LAST_ALIVE_FILE)) {
      const raw = readFileSync(LAST_ALIVE_FILE, "utf-8");
      const { timestamp } = JSON.parse(raw);
      clearLastAlive();
      if (timestamp) {
        console.log("State: no state file found, using last-alive timestamp as fallback");
        return {
          timestamp,
          reason: "crash",
          uptimeSeconds: 0,
          error: "Process was killed without a clean shutdown (no state file written)",
        };
      }
    }
  } catch {
    // Fall through
  }
  return null;
}

/** Update the last-alive timestamp on disk. Called from heartbeat. */
export function updateLastAlive(): void {
  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    writeFileSync(LAST_ALIVE_FILE, JSON.stringify({ timestamp: new Date().toISOString() }), "utf-8");
  } catch {
    // Best effort
  }
}

/** Clear the last-alive file (called after consuming it on startup). */
function clearLastAlive(): void {
  try {
    if (existsSync(LAST_ALIVE_FILE)) unlinkSync(LAST_ALIVE_FILE);
  } catch {
    // Best effort
  }
}

/** Format a human-readable Discord message about the restart. */
export function formatRestartMessage(prev: StateFile): string {
  const down = timeSince(prev.timestamp);

  switch (prev.reason) {
    case "clean":
      return `Back online after clean shutdown (was down for ${down}).`;
    case "reboot":
      return `Back online after reboot (was down for ${down}).`;
    case "crash":
      return `Recovered from crash (down for ${down}).\n**Error:** \`${prev.error?.slice(0, 500) ?? "unknown"}\``;
    case "fatal":
      return `Recovered from fatal startup error (down for ${down}).\n**Error:** \`${prev.error?.slice(0, 500) ?? "unknown"}\``;
    default:
      return `Back online (was down for ${down}).`;
  }
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem}m`;
}

// ── Calendar reminder dedup ─────────────────────────────────────

/** Load persisted calendar notification UIDs. */
export function loadCalendarNotified(): string[] {
  try {
    if (existsSync(CALENDAR_NOTIFIED_FILE)) {
      return JSON.parse(readFileSync(CALENDAR_NOTIFIED_FILE, "utf-8"));
    }
  } catch {
    // Start fresh
  }
  return [];
}

/** Persist calendar notification UIDs to disk. */
export function saveCalendarNotified(uids: string[]): void {
  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    writeFileSync(CALENDAR_NOTIFIED_FILE, JSON.stringify(uids), "utf-8");
    console.log(`State: saved ${uids.length} calendar notification UID(s)`);
  } catch {
    // Best effort
  }
}

// ── Reply checker dedup ─────────────────────────────────────────

/** Load persisted reply-checked message IDs. */
export function loadReplyChecked(): string[] {
  try {
    if (existsSync(REPLY_CHECKED_FILE)) {
      return JSON.parse(readFileSync(REPLY_CHECKED_FILE, "utf-8"));
    }
  } catch {
    // Start fresh
  }
  return [];
}

/** Persist reply-checked message IDs to disk. */
export function saveReplyChecked(ids: string[]): void {
  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    writeFileSync(REPLY_CHECKED_FILE, JSON.stringify(ids), "utf-8");
  } catch {
    // Best effort
  }
}

// ── Active persona persistence ──────────────────────────────────

/** Load the last active persona name from disk. Returns null if none saved. */
export function loadActivePersona(): string | null {
  try {
    if (existsSync(ACTIVE_PERSONA_FILE)) {
      const name = JSON.parse(readFileSync(ACTIVE_PERSONA_FILE, "utf-8"));
      console.log(`State: loaded active persona "${name}"`);
      return name;
    }
  } catch {
    // Fall back to config default
  }
  return null;
}

/** Persist the active persona name to disk so it survives restarts. */
export function saveActivePersona(name: string): void {
  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    writeFileSync(ACTIVE_PERSONA_FILE, JSON.stringify(name), "utf-8");
    console.log(`State: saved active persona "${name}"`);
  } catch {
    // Best effort
  }
}

// ── Tool & agent toggle persistence ─────────────────────────────

type ToggleState = {
  tools: Record<string, boolean>;
  agents: Record<string, boolean>;
};

/** Load saved tool/agent toggle overrides from disk. */
export function loadToggleState(): ToggleState | null {
  try {
    if (existsSync(TOGGLE_STATE_FILE)) {
      return JSON.parse(readFileSync(TOGGLE_STATE_FILE, "utf-8"));
    }
  } catch {
    // Start fresh
  }
  return null;
}

function saveToggleState(state: ToggleState): void {
  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    writeFileSync(TOGGLE_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Best effort
  }
}

/** Persist a tool toggle change. Read-modify-writes the shared file. */
export function saveToolToggle(name: string, enabled: boolean): void {
  const state = loadToggleState() ?? { tools: {}, agents: {} };
  state.tools[name] = enabled;
  saveToggleState(state);
}

/** Persist an agent toggle change. Read-modify-writes the shared file. */
export function saveAgentToggle(name: string, enabled: boolean): void {
  const state = loadToggleState() ?? { tools: {}, agents: {} };
  state.agents[name] = enabled;
  saveToggleState(state);
}

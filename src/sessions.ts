import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SESSIONS_FILE = "data/sessions.json";

type UserStats = {
  username: string;
  messageCount: number;
  lastMessage: string; // ISO timestamp
};

type ChannelSession = {
  channelId: string;
  guildId: string | null;
  channelName: string | null;
  firstMessage: string; // ISO timestamp
  lastMessage: string;  // ISO timestamp
  messageCount: number;
  users: Record<string, UserStats>; // keyed by userId
};

type SessionStore = Record<string, ChannelSession>; // keyed by channelId

let store: SessionStore = {};

function load(): void {
  try {
    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    store = JSON.parse(raw);
  } catch {
    store = {};
  }
}

function save(): void {
  try {
    mkdirSync("data", { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error("Sessions: failed to save:", err);
  }
}

/**
 * Record a message interaction for session tracking.
 */
export function recordMessage(info: {
  channelId: string;
  guildId: string | null;
  channelName: string | null;
  userId: string;
  username: string;
}): void {
  const now = new Date().toISOString();
  const { channelId, guildId, channelName, userId, username } = info;

  let session = store[channelId];
  if (!session) {
    session = {
      channelId,
      guildId,
      channelName,
      firstMessage: now,
      lastMessage: now,
      messageCount: 0,
      users: {},
    };
    store[channelId] = session;
  }

  session.lastMessage = now;
  session.messageCount++;

  // Update channel name if it changed
  if (channelName) session.channelName = channelName;

  // Per-user stats
  if (!session.users[userId]) {
    session.users[userId] = {
      username,
      messageCount: 0,
      lastMessage: now,
    };
  }

  const user = session.users[userId];
  user.messageCount++;
  user.lastMessage = now;
  user.username = username; // keep display name current

  save();
}

/**
 * Get all session data.
 */
export function getAllSessions(): ChannelSession[] {
  return Object.values(store);
}

/**
 * Get session data for a specific channel.
 */
export function getSession(channelId: string): ChannelSession | null {
  return store[channelId] ?? null;
}

/**
 * Delete a session by channel ID.
 */
export function deleteSession(channelId: string): boolean {
  if (!store[channelId]) return false;
  delete store[channelId];
  save();
  return true;
}

/**
 * Delete all sessions.
 */
export function clearAllSessions(): number {
  const count = Object.keys(store).length;
  store = {};
  save();
  return count;
}

/**
 * Remove sessions older than maxAgeDays (based on lastMessage).
 * Returns the number of sessions archived.
 */
export function archiveOldSessions(maxAgeDays: number): number {
  if (maxAgeDays <= 0) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let archived = 0;

  for (const [channelId, session] of Object.entries(store)) {
    if (new Date(session.lastMessage).getTime() < cutoff) {
      delete store[channelId];
      archived++;
    }
  }

  if (archived > 0) {
    save();
    console.log(`Sessions: archived ${archived} session(s) older than ${maxAgeDays} days`);
  }

  return archived;
}

// Load from disk on module init
load();

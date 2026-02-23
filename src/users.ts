import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const USERS_FILE = "data/users.json";

export type UserProfile = {
  userId: string;
  username: string;
  firstSeen: string;
  lastSeen: string;
  messageCount: number;
  channels: string[];
};

type UserStore = Record<string, UserProfile>;

let store: UserStore = {};

function load(): void {
  try {
    const raw = readFileSync(USERS_FILE, "utf-8");
    store = JSON.parse(raw);
  } catch {
    store = {};
  }
}

function save(): void {
  try {
    mkdirSync("data", { recursive: true });
    writeFileSync(USERS_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error("Users: failed to save:", err);
  }
}

// Load on module init
load();

/**
 * Create or update a user profile on each message.
 */
export function updateUser(userId: string, username: string, channelId: string): void {
  const now = new Date().toISOString();

  let profile = store[userId];
  if (!profile) {
    profile = {
      userId,
      username,
      firstSeen: now,
      lastSeen: now,
      messageCount: 0,
      channels: [],
    };
    store[userId] = profile;
  }

  profile.username = username;
  profile.lastSeen = now;
  profile.messageCount++;

  if (!profile.channels.includes(channelId)) {
    profile.channels.push(channelId);
  }

  save();
}

export function getUser(userId: string): UserProfile | undefined {
  return store[userId];
}

export function getAllUsers(): UserStore {
  return store;
}

export function deleteUser(userId: string): boolean {
  if (!store[userId]) return false;
  delete store[userId];
  save();
  return true;
}

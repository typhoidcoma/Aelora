import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const LOGS_DIR = "data/memory/logs";

type LogEntry = {
  channelName: string;
  userId: string;
  username: string;
  summary: string;
};

function ensureDir(): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

function dateToFilename(date: string): string {
  return join(LOGS_DIR, `${date}.md`);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowTime(): string {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Append a conversation snippet to today's daily log.
 */
export function appendLog(entry: LogEntry): void {
  ensureDir();
  const file = dateToFilename(todayDate());

  const block = [
    `## ${nowTime()} — #${entry.channelName} (${entry.username})`,
    "",
    entry.summary,
    "",
    "---",
    "",
  ].join("\n");

  try {
    const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
    writeFileSync(file, existing + block, "utf-8");
  } catch (err) {
    console.error("DailyLog: failed to append:", err);
  }
}

/**
 * Read a specific day's log. Returns empty string if none exists.
 */
export function readLog(date?: string): string {
  const file = dateToFilename(date ?? todayDate());
  try {
    return existsSync(file) ? readFileSync(file, "utf-8") : "";
  } catch {
    return "";
  }
}

/**
 * Keyword search across all log files (newest first).
 * Returns matching blocks with their date.
 */
export function searchLogs(
  query: string,
  maxResults = 20,
): { date: string; excerpt: string }[] {
  const results: { date: string; excerpt: string }[] = [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return results;

  const dates = listLogDates(); // already newest-first

  for (const date of dates) {
    if (results.length >= maxResults) break;

    const content = readLog(date);
    // Split into blocks by the ## heading pattern
    const blocks = content.split(/(?=^## )/m).filter(Boolean);

    for (const block of blocks) {
      if (results.length >= maxResults) break;
      const lower = block.toLowerCase();
      if (terms.every((t) => lower.includes(t))) {
        results.push({ date, excerpt: block.trim().slice(0, 500) });
      }
    }
  }

  return results;
}

/**
 * List available log dates (newest first).
 */
export function listLogDates(): string[] {
  ensureDir();
  try {
    return readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(".md", ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

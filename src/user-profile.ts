/**
 * Per-user profile files — LLM-synthesized markdown dossiers stored at
 * data/users/{userId}.md. Always injected into the system prompt so the
 * bot has comprehensive knowledge of each user regardless of conversation topic.
 *
 * Profiles are rebuilt automatically when enough new facts accumulate.
 */

import { readFileSync, existsSync } from "node:fs";
import type OpenAI from "openai";
import { getFacts } from "./memory.js";
import { getUser } from "./users.js";
import { getLLMClient, getAuxiliaryModel, getDisableThinking, stripThinkBlocks } from "./llm.js";
import { queueTextWrite } from "./async-write-queue.js";
import { recordCompletionUsage } from "./token-tracker.js";
import { broadcastEvent } from "./logger.js";
import { updateUserProfileBuild } from "./users.js";

// ── Constants ───────────────────────────────────────────

const PROFILE_DIR = "data/users";
const PROFILE_REBUILD_THRESHOLD = 3;  // rebuild after this many new facts
const PROFILE_MIN_FACTS = 5;          // don't build until user has this many facts
const MAX_PROFILE_CHARS = 3500;       // ~875 tokens hard cap

// ── State ───────────────────────────────────────────────

const factsAddedSince = new Map<string, number>();

// ── Profile builder prompt ──────────────────────────────

function buildProfilePrompt(username: string): string {
  return (
    "You are building a comprehensive personal dossier for an AI companion's knowledge of a user.\n\n" +
    `The user's name/handle is "${username}".\n\n` +
    "Synthesize ALL provided facts into a structured markdown document using ONLY these sections " +
    "(omit any section where you have no concrete knowledge):\n\n" +
    "## Identity\nName, age, location, job/role, key biographical facts.\n\n" +
    "## Personality & Style\nCommunication style, humor, energy level, how they interact.\n\n" +
    "## Interests & Preferences\nLikes, dislikes, hobbies, tastes, opinions.\n\n" +
    "## Technical\nLanguages, tools, frameworks, projects, skill level.\n\n" +
    "## Relationships & Social\nPeople they mention by name, dynamics, social context.\n\n" +
    "## Goals & Current Focus\nActive projects, aspirations, current life situation.\n\n" +
    "## Recent Context\nTasks, appointments, deadlines, time-sensitive items.\n\n" +
    "Rules:\n" +
    "- If an existing profile is provided, UPDATE it — preserve information that isn't contradicted by new facts.\n" +
    "- Write in third person: 'They are...' / 'Their name is...'\n" +
    "- Be specific and factual. Include names, tools, dates, preferences — not vague generalities.\n" +
    "- Stay under 3000 characters total.\n" +
    "- Output ONLY the markdown document. No preamble, no explanation.\n" +
    "- Do NOT include a top-level heading with the user's name — start directly with the first ## section."
  );
}

// ── Public API ──────────────────────────────────────────

/** Read a user's profile file from disk. Returns content or null. */
export function getUserProfile(userId: string): string | null {
  const filePath = `${PROFILE_DIR}/${userId}.md`;
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf-8").trim();
    }
  } catch { /* file not readable */ }
  return null;
}

/** Read profile and truncate to token-safe length for prompt injection. */
export function getProfileForPrompt(userId: string): string | null {
  const content = getUserProfile(userId);
  if (!content) return null;
  return content.slice(0, MAX_PROFILE_CHARS);
}

/** Track that a new fact was saved for a user. Call after each successful saveFact. */
export function trackProfileFactAdded(userId: string): void {
  factsAddedSince.set(userId, (factsAddedSince.get(userId) ?? 0) + 1);
}

/** Check if a user's profile should be rebuilt based on accumulated new facts. */
export function shouldRebuildProfile(userId: string): boolean {
  const added = factsAddedSince.get(userId) ?? 0;
  if (added < PROFILE_REBUILD_THRESHOLD) return false;
  const totalFacts = getFacts(`user:${userId}`).length;
  return totalFacts >= PROFILE_MIN_FACTS;
}

/**
 * Rebuild a user's profile from all their facts using an LLM synthesis pass.
 * Fire-and-forget — errors are logged but don't propagate.
 */
export async function buildUserProfile(userId: string): Promise<void> {
  // Reset counter
  factsAddedSince.set(userId, 0);

  const facts = getFacts(`user:${userId}`);
  if (facts.length === 0) return;

  const userProfile = getUser(userId);
  const username = userProfile?.username ?? userId;

  // Build fact list grouped by category
  const factsByCategory = new Map<string, string[]>();
  for (const f of facts) {
    const cat = f.category || "contextual";
    if (!factsByCategory.has(cat)) factsByCategory.set(cat, []);
    factsByCategory.get(cat)!.push(f.fact);
  }

  let factList = "";
  for (const [category, catFacts] of factsByCategory) {
    factList += `\n[${category}]\n`;
    for (const fact of catFacts) {
      factList += `- ${fact}\n`;
    }
  }

  // Include existing profile for update-in-place
  const existingProfile = getUserProfile(userId);
  let userContent = `Facts about ${username} (${facts.length} total):\n${factList}`;
  if (existingProfile) {
    userContent += `\n\nExisting profile to update:\n${existingProfile}`;
  }

  const client = getLLMClient();
  const model = getAuxiliaryModel();

  try {
    const params: Record<string, unknown> = {
      model,
      max_completion_tokens: 4096,
      ...(getDisableThinking() ? { enable_thinking: false } : {}),
      messages: [
        { role: "system", content: buildProfilePrompt(username) },
        { role: "user", content: getDisableThinking() ? `/no_think\n${userContent}` : userContent },
      ],
    };

    const result = await client.chat.completions.create(
      params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    );
    recordCompletionUsage(result, model, "profile");

    let content = stripThinkBlocks(result.choices[0]?.message?.content?.trim() ?? "");
    if (!content) return;

    // Strip markdown code fences if model wraps output
    content = content.replace(/^```(?:markdown|md)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();

    // Enforce character cap
    if (content.length > MAX_PROFILE_CHARS) {
      // Truncate at the last complete section boundary within the cap
      const truncated = content.slice(0, MAX_PROFILE_CHARS);
      const lastSection = truncated.lastIndexOf("\n## ");
      content = lastSection > 0 ? truncated.slice(0, lastSection).trim() : truncated.trim();
    }

    // Write to disk
    const filePath = `${PROFILE_DIR}/${userId}.md`;
    queueTextWrite(filePath, content, { debounceMs: 500, atomic: true });

    // Update user profile tracking
    updateUserProfileBuild(userId, facts.length);

    console.log(`UserProfile: built profile for ${username} (${userId}) — ${content.length} chars from ${facts.length} facts`);

    broadcastEvent("mindmap", {
      type: "profile:built",
      userId,
      username,
      factCount: facts.length,
      profileChars: content.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`UserProfile: failed to build profile for ${userId}:`, err instanceof Error ? err.message : err);
  }
}

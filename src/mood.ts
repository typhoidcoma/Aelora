import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { broadcastEvent } from "./logger.js";
import { getLLMClient, getLLMModel } from "./llm.js";

// Plutchik's 8 primary emotions with intensity levels (low → mid → high)
export const PLUTCHIK_EMOTIONS = {
  joy:          { low: "serenity",     mid: "joy",          high: "ecstasy" },
  trust:        { low: "acceptance",   mid: "trust",        high: "admiration" },
  fear:         { low: "apprehension", mid: "fear",         high: "terror" },
  surprise:     { low: "distraction",  mid: "surprise",     high: "amazement" },
  sadness:      { low: "pensiveness",  mid: "sadness",      high: "grief" },
  disgust:      { low: "boredom",      mid: "disgust",      high: "loathing" },
  anger:        { low: "annoyance",    mid: "anger",        high: "rage" },
  anticipation: { low: "interest",     mid: "anticipation", high: "vigilance" },
} as const;

export type PrimaryEmotion = keyof typeof PLUTCHIK_EMOTIONS;
export type Intensity = "low" | "mid" | "high";

export type MoodState = {
  emotion: PrimaryEmotion;
  intensity: Intensity;
  secondary?: PrimaryEmotion;
  note?: string;
  updatedAt: string;
};

const MOOD_FILE = "data/current-mood.json";
const CLASSIFY_COOLDOWN_MS = 30 * 1000; // 30 seconds minimum between API calls

const MOOD_EMOJI: Record<PrimaryEmotion, string> = {
  joy: "✨", trust: "🤝", fear: "😰", surprise: "😲",
  sadness: "😢", disgust: "😒", anger: "🔥", anticipation: "👀",
};

// Callback for Discord status updates (avoids circular import with discord/client)
let moodChangeCallback: ((emoji: string, label: string) => void) | null = null;
export function onMoodChange(cb: (emoji: string, label: string) => void): void { moodChangeCallback = cb; }

const EMOTIONS = Object.keys(PLUTCHIK_EMOTIONS) as PrimaryEmotion[];
const INTENSITIES: Intensity[] = ["low", "mid", "high"];

const CLASSIFY_SYSTEM = `You are an emotion classifier. Given a bot's response and the user message it replied to, classify the bot's emotional tone using Plutchik's wheel.

Return ONLY a JSON object with these fields:
- "emotion": one of ${EMOTIONS.join(", ")}
- "intensity": one of low, mid, high
- "secondary": (optional) a second emotion if blended
- "note": (optional) 1-sentence reason, max 100 chars

Example: {"emotion":"joy","intensity":"mid","secondary":"trust","note":"warm helpful exchange"}`;

export function saveMood(mood: MoodState): void {
  mkdirSync("data", { recursive: true });
  writeFileSync(MOOD_FILE, JSON.stringify(mood, null, 2));
  console.log(
    `Mood: ${resolveLabel(mood)} (${mood.emotion}/${mood.intensity}${mood.secondary ? `+${mood.secondary}` : ""})`,
  );

  // Push live update to all connected dashboards
  broadcastEvent("mood", {
    active: true,
    emotion: mood.emotion,
    intensity: mood.intensity,
    label: resolveLabel(mood),
    secondary: mood.secondary ?? null,
    note: mood.note ?? null,
    updatedAt: mood.updatedAt,
  });

  // Update Discord bot status with emoji + mood label
  if (moodChangeCallback) {
    moodChangeCallback(MOOD_EMOJI[mood.emotion], resolveLabel(mood));
  }
}

export function loadMood(): MoodState | null {
  try {
    return JSON.parse(readFileSync(MOOD_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/** Resolve the specific emotion word (e.g. "serenity" for joy/low). */
export function resolveLabel(mood: MoodState): string {
  return PLUTCHIK_EMOTIONS[mood.emotion][mood.intensity];
}

/** Build the prompt section injected into the system prompt. */
export function buildMoodPromptSection(): string {
  const mood = loadMood();
  if (!mood) {
    return "## Current Mood\nNo mood set yet — it will be detected automatically from your responses.";
  }

  const label = resolveLabel(mood);
  let line = `## Current Mood\nYou are currently feeling **${label}**`;
  if (mood.secondary) {
    const secondaryLabel = PLUTCHIK_EMOTIONS[mood.secondary].mid;
    line += ` with undertones of **${secondaryLabel}**`;
  }
  if (mood.note) {
    line += ` — ${mood.note}`;
  }
  line += ".";
  return line;
}

/**
 * Auto-classify mood from the bot's response text.
 * Makes a lightweight direct LLM call (no tools, no persona).
 * Skips if mood was updated less than CLASSIFY_COOLDOWN_MS ago.
 */
export async function classifyMood(botResponse: string, userMessage: string): Promise<void> {
  // Throttle: skip if classified very recently (prevents API spam during rapid-fire messages)
  const current = loadMood();
  if (current) {
    const elapsed = Date.now() - new Date(current.updatedAt).getTime();
    if (elapsed < CLASSIFY_COOLDOWN_MS) {
      console.log(`Mood classify: skipped (${Math.round(elapsed / 1000)}s since last update, cooldown ${CLASSIFY_COOLDOWN_MS / 1000}s)`);
      return;
    }
  }

  const client = getLLMClient();
  const model = getLLMModel();

  const result = await client.chat.completions.create({
    model,
    max_completion_tokens: 120,
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM },
      { role: "user", content: `User: ${userMessage.slice(0, 300)}\n\nBot: ${botResponse.slice(0, 500)}` },
    ],
  });

  const rawContent = result.choices[0]?.message?.content?.trim();
  if (!rawContent) return;

  // Strip <think>…</think> blocks (reasoning models like Qwen/DeepSeek) then markdown code fences
  const raw = rawContent.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/<think>[\s\S]*$/g, "").trim();
  if (!raw) return;

  // Extract JSON from response (handle markdown code fences)
  const jsonStr = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.warn("Mood classify: failed to parse JSON:", raw.slice(0, 100));
    return;
  }

  // Validate fields
  const emotion = parsed.emotion as string;
  const intensity = (parsed.intensity as string) ?? "mid";
  if (!EMOTIONS.includes(emotion as PrimaryEmotion)) return;
  if (!INTENSITIES.includes(intensity as Intensity)) return;

  const mood: MoodState = {
    emotion: emotion as PrimaryEmotion,
    intensity: intensity as Intensity,
    ...(parsed.secondary && EMOTIONS.includes(parsed.secondary as PrimaryEmotion)
      ? { secondary: parsed.secondary as PrimaryEmotion }
      : {}),
    ...(typeof parsed.note === "string" ? { note: parsed.note.slice(0, 200) } : {}),
    updatedAt: new Date().toISOString(),
  };

  saveMood(mood);
}

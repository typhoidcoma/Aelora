import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

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

export function saveMood(mood: MoodState): void {
  mkdirSync("data", { recursive: true });
  writeFileSync(MOOD_FILE, JSON.stringify(mood, null, 2));
  console.log(
    `Mood: ${resolveLabel(mood)} (${mood.emotion}/${mood.intensity}${mood.secondary ? `+${mood.secondary}` : ""})`,
  );
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
export function buildMoodPromptSection(): string | null {
  const mood = loadMood();
  if (!mood) return null;

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

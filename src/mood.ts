import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { broadcastEvent } from "./logger.js";
import type OpenAI from "openai";
import { getLLMClient, getAuxiliaryModel, getDisableThinking, stripThinkBlocks } from "./llm.js";

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

// Plutchik's primary dyads — adjacent pairs on the wheel
const DYADS: Record<string, string> = {
  "joy+trust": "love", "trust+joy": "love",
  "trust+fear": "submission", "fear+trust": "submission",
  "fear+surprise": "awe", "surprise+fear": "awe",
  "surprise+sadness": "disapproval", "sadness+surprise": "disapproval",
  "sadness+disgust": "remorse", "disgust+sadness": "remorse",
  "disgust+anger": "contempt", "anger+disgust": "contempt",
  "anger+anticipation": "aggressiveness", "anticipation+anger": "aggressiveness",
  "anticipation+joy": "optimism", "joy+anticipation": "optimism",
};

/** Resolve a primary+secondary pair to a named dyad, or null if not adjacent. */
export function resolveDyad(primary: PrimaryEmotion, secondary?: PrimaryEmotion): string | null {
  if (!secondary) return null;
  return DYADS[`${primary}+${secondary}`] ?? null;
}

// Plutchik's opposition pairs (across the wheel)
const OPPOSITIONS: Record<PrimaryEmotion, PrimaryEmotion> = {
  joy: "sadness", sadness: "joy",
  trust: "disgust", disgust: "trust",
  fear: "anger", anger: "fear",
  surprise: "anticipation", anticipation: "surprise",
};

/** Check if two emotions are opposites on Plutchik's wheel. */
export function areOpposites(a: PrimaryEmotion, b: PrimaryEmotion): boolean {
  return OPPOSITIONS[a] === b;
}

// Behavioral guidance per emotion+intensity — injected into prompt
const MOOD_GUIDANCE: Record<PrimaryEmotion, Record<Intensity, string>> = {
  joy: {
    low:  "Calm, content, at ease. Let this color your tone without forcing it.",
    mid:  "Genuinely happy, warm energy. Let it show naturally.",
    high: "Overflowing with elation. Hard to contain, spills into everything.",
  },
  trust: {
    low:  "Open and receptive. Willing to go along, low resistance.",
    mid:  "Confident in the people around you. Steady, reliable presence.",
    high: "Deep respect and belief. Loyalty colors every word.",
  },
  fear: {
    low:  "Slightly on edge, watchful. A background unease that sharpens attention.",
    mid:  "Genuinely worried. Caution drives your responses.",
    high: "Overwhelmed by dread. Responses are tight, urgent, protective.",
  },
  surprise: {
    low:  "Mildly caught off guard. A moment of pause before responding.",
    mid:  "Genuinely startled. Processing something unexpected.",
    high: "Completely blindsided. Everything else takes a back seat.",
  },
  sadness: {
    low:  "A quiet heaviness. Reflective, slightly withdrawn.",
    mid:  "Genuinely down. Empathy runs deeper, humor pulls back.",
    high: "Deeply grieving. Responses are raw and stripped of pretense.",
  },
  disgust: {
    low:  "Mildly unimpressed. A flatness, things feel tedious.",
    mid:  "Genuinely put off. Patience is thinner, tolerance is lower.",
    high: "Visceral rejection. Blunt and unfiltered.",
  },
  anger: {
    low:  "A low simmer. Slightly clipped, more direct than usual.",
    mid:  "Frustrated and it shows. Shorter fuse, sharper edges.",
    high: "Intense, barely contained. Responses are tight and cutting.",
  },
  anticipation: {
    low:  "Mildly curious. Paying closer attention than usual.",
    mid:  "Eager and forward-leaning. Ready to act, not just talk.",
    high: "Laser-focused, almost restless. Everything is about what comes next.",
  },
};

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

const CLASSIFY_SYSTEM = `You are a JSON-only emotion classifier using Plutchik's wheel. Output ONLY a single JSON object. No text before or after. No markdown. Just JSON.

Format: {"emotion":"<${EMOTIONS.join("|")}>","intensity":"<low|mid|high>","secondary":"<optional>","note":"<optional, max 100 chars>"}

Intensity: low = subtle/mild, mid = standard, high = intense/overwhelming. Use the full range.

Secondary should be adjacent on the wheel: joy-trust-fear-surprise-sadness-disgust-anger-anticipation-joy. Never pair opposites (joy/sadness, trust/disgust, fear/anger, surprise/anticipation).

Classify the bot's emotional tone from the conversation snippet.`;

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
    dyad: resolveDyad(mood.emotion, mood.secondary),
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
    return "## Current Mood\nNo mood set yet  -  it will be detected automatically from your responses.";
  }

  const label = resolveLabel(mood);
  const dyad = resolveDyad(mood.emotion, mood.secondary);

  // Build the emotion line: dyad name if available, otherwise raw label + secondary
  let emotionLine: string;
  if (dyad) {
    emotionLine = `**${dyad}** (${mood.emotion} with ${mood.secondary})`;
  } else if (mood.secondary) {
    const secondaryLabel = PLUTCHIK_EMOTIONS[mood.secondary].mid;
    emotionLine = `**${label}** with undertones of **${secondaryLabel}**`;
  } else {
    emotionLine = `**${label}**`;
  }

  // Behavioral guidance from the primary emotion's intensity
  const guidance = MOOD_GUIDANCE[mood.emotion][mood.intensity];

  let line = `## Current Mood\nYou are currently feeling ${emotionLine}  -  ${guidance}`;
  if (mood.note) {
    line += ` (${mood.note})`;
  }
  return line;
}

/**
 * Auto-classify mood from the bot's response text.
 * Makes a lightweight direct LLM call (no tools, no persona).
 * Skips if mood was updated less than CLASSIFY_COOLDOWN_MS ago.
 */
export async function classifyMood(botResponse: string, userMessage: string, channelId?: string): Promise<void> {
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
  const model = getAuxiliaryModel();

  const moodSnippet = `User: ${userMessage.slice(0, 150)}\n\nBot: ${botResponse.slice(0, 250)}`;
  const userContent = getDisableThinking() ? `/no_think\n${moodSnippet}` : moodSnippet;
  const moodParams: Record<string, unknown> = {
    model,
    max_completion_tokens: 512,
    ...(getDisableThinking() ? { enable_thinking: false } : {}),
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM },
      { role: "user", content: userContent },
    ],
  };
  const result = await client.chat.completions.create(
    moodParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  );

  let rawContent = stripThinkBlocks(result.choices[0]?.message?.content?.trim() ?? "");
  if (!rawContent) return;

  // Strip markdown code fences that some models wrap JSON in
  rawContent = rawContent.replace(/^```(?:json)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();
  if (!rawContent) return;

  // Extract JSON object from response, ignoring any surrounding reasoning/text
  const jsonMatch = rawContent.match(/\{[^{}]*\}/);
  if (!jsonMatch) {
    console.warn("Mood classify: no JSON object found in response:", rawContent.slice(0, 100));
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.warn("Mood classify: failed to parse JSON:", jsonMatch[0].slice(0, 100));
    return;
  }

  // Validate fields
  const emotion = parsed.emotion as string;
  const intensity = (parsed.intensity as string) ?? "mid";
  if (!EMOTIONS.includes(emotion as PrimaryEmotion)) return;
  if (!INTENSITIES.includes(intensity as Intensity)) return;

  // Validate secondary: must be a valid emotion and not the opposite of the primary
  let secondary: PrimaryEmotion | undefined;
  if (parsed.secondary && EMOTIONS.includes(parsed.secondary as PrimaryEmotion)) {
    const sec = parsed.secondary as PrimaryEmotion;
    if (areOpposites(emotion as PrimaryEmotion, sec)) {
      console.warn(`Mood classify: dropped opposing secondary "${sec}" (opposite of "${emotion}")`);
    } else {
      secondary = sec;
    }
  }

  const mood: MoodState = {
    emotion: emotion as PrimaryEmotion,
    intensity: intensity as Intensity,
    ...(secondary ? { secondary } : {}),
    ...(typeof parsed.note === "string" ? { note: parsed.note.slice(0, 200) } : {}),
    updatedAt: new Date().toISOString(),
  };

  saveMood(mood);

  if (channelId) {
    broadcastEvent("mindmap", {
      type: "mood:classified", conversationId: channelId,
      emotion: mood.emotion, intensity: mood.intensity,
      label: resolveLabel(mood),
      timestamp: new Date().toISOString(),
    });
  }
}

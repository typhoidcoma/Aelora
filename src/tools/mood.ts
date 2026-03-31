import { defineTool, param } from "./types.js";
import {
  saveMood,
  resolveLabel,
  resolveDyad,
  areOpposites,
  PLUTCHIK_EMOTIONS,
  type PrimaryEmotion,
  type Intensity,
  type MoodState,
} from "../mood.js";

const emotions = Object.keys(PLUTCHIK_EMOTIONS) as PrimaryEmotion[];
const intensities: Intensity[] = ["low", "mid", "high"];

export default defineTool({
  name: "set_mood",
  description:
    "Manually override your current emotional state using Plutchik's wheel. Adjacent pairs form dyads: joy+trust=love, trust+fear=submission, fear+surprise=awe, surprise+sadness=disapproval, sadness+disgust=remorse, disgust+anger=contempt, anger+anticipation=aggressiveness, anticipation+joy=optimism.",

  params: {
    emotion: param.enum(
      "Primary emotion (Plutchik's wheel).",
      emotions,
      { required: true },
    ),
    intensity: param.enum(
      "Emotion intensity: low (mild), mid (default), or high (intense).",
      intensities,
    ),
    secondary: param.enum(
      "Optional secondary emotion for blends (e.g. joy+trust = love).",
      emotions,
    ),
    note: param.string("Brief context for why your mood shifted.", {
      maxLength: 200,
    }),
  },

  handler: async ({ emotion, intensity, secondary, note }) => {
    const pri = emotion as PrimaryEmotion;
    const sec = secondary as PrimaryEmotion | undefined;

    const mood: MoodState = {
      emotion: pri,
      intensity: (intensity as Intensity) ?? "mid",
      ...(sec ? { secondary: sec } : {}),
      ...(note ? { note } : {}),
      updatedAt: new Date().toISOString(),
    };

    saveMood(mood);

    const label = resolveLabel(mood);
    const dyad = resolveDyad(pri, sec);
    const warnings: string[] = [];

    if (sec && areOpposites(pri, sec)) {
      warnings.push(`Warning: ${pri} and ${sec} are opposing emotions on Plutchik's wheel.`);
    }

    const moodText = dyad ? `${dyad} (${label})` : label;
    const text = [`Mood updated to ${moodText}.`, ...warnings].join(" ");

    return {
      text,
      data: { action: "set_mood", label, dyad, ...mood },
    };
  },
});

import { defineTool, param } from "./types.js";
import {
  saveMood,
  resolveLabel,
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
    "Manually override your current emotional state. Use this when you want to express an intentional mood shift that auto-detection might miss.",

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
    const mood: MoodState = {
      emotion: emotion as PrimaryEmotion,
      intensity: (intensity as Intensity) ?? "mid",
      ...(secondary ? { secondary: secondary as PrimaryEmotion } : {}),
      ...(note ? { note } : {}),
      updatedAt: new Date().toISOString(),
    };

    saveMood(mood);
    return `Mood updated to ${resolveLabel(mood)}.`;
  },
});

import { broadcastEvent } from "./logger.js";
import type { PrimaryEmotion, Intensity } from "./mood.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Continuous 8D emotion space — each dimension 0.0–1.0 */
export type EmotionVector = {
  joy: number;
  trust: number;
  fear: number;
  surprise: number;
  sadness: number;
  disgust: number;
  anger: number;
  anticipation: number;
};

const EMOTION_KEYS: (keyof EmotionVector)[] = [
  "joy", "trust", "fear", "surprise", "sadness", "disgust", "anger", "anticipation",
];

// ── Utilities ────────────────────────────────────────────────────────────────

export function zeroVector(): EmotionVector {
  return { joy: 0, trust: 0, fear: 0, surprise: 0, sadness: 0, disgust: 0, anger: 0, anticipation: 0 };
}

const INTENSITY_MAP: Record<Intensity, number> = { low: 0.33, mid: 0.66, high: 1.0 };

/** Convert a discrete MoodState into continuous vector space. */
export function moodStateToVector(mood: { emotion: PrimaryEmotion; intensity: Intensity; secondary?: PrimaryEmotion }): EmotionVector {
  const v = zeroVector();
  v[mood.emotion] = INTENSITY_MAP[mood.intensity];
  if (mood.secondary && mood.secondary in v) {
    v[mood.secondary] = 0.25;
  }
  return v;
}

/** Return the emotion with the highest activation. */
export function dominantEmotion(v: EmotionVector): { emotion: keyof EmotionVector; value: number } {
  let best: keyof EmotionVector = "joy";
  let max = -1;
  for (const k of EMOTION_KEYS) {
    if (v[k] > max) { max = v[k]; best = k; }
  }
  return { emotion: best, value: max };
}

// ── Emotion Lexicon ──────────────────────────────────────────────────────────

type PartialVector = Partial<EmotionVector>;

/**
 * Keyword → partial emotion vector.
 * Only the dimensions with signal are specified; others default to 0.
 */
const EMOTION_LEXICON: Record<string, PartialVector> = {
  // Joy
  happy: { joy: 0.7 }, glad: { joy: 0.5 }, delighted: { joy: 0.8 }, cheerful: { joy: 0.6 },
  excited: { joy: 0.7, anticipation: 0.5 }, thrilled: { joy: 0.9, surprise: 0.3 },
  wonderful: { joy: 0.7 }, fantastic: { joy: 0.8 }, great: { joy: 0.5 }, amazing: { joy: 0.7, surprise: 0.3 },
  awesome: { joy: 0.7 }, beautiful: { joy: 0.6, trust: 0.3 }, love: { joy: 0.6, trust: 0.6 },
  adore: { joy: 0.7, trust: 0.5 }, enjoy: { joy: 0.5 }, fun: { joy: 0.5 }, laugh: { joy: 0.6 },
  smile: { joy: 0.5 }, celebrate: { joy: 0.7 }, yay: { joy: 0.7 }, haha: { joy: 0.5 },
  lol: { joy: 0.4 }, hehe: { joy: 0.4 }, pleased: { joy: 0.5 }, bliss: { joy: 0.9 },
  ecstatic: { joy: 0.95 }, euphoria: { joy: 0.9 }, elated: { joy: 0.8 },
  // Trust
  trust: { trust: 0.7 }, believe: { trust: 0.5 }, reliable: { trust: 0.6 },
  safe: { trust: 0.6 }, secure: { trust: 0.6 }, honest: { trust: 0.6 },
  loyal: { trust: 0.7 }, faith: { trust: 0.6 }, confident: { trust: 0.5, joy: 0.2 },
  depend: { trust: 0.5 }, support: { trust: 0.5 }, friend: { trust: 0.5, joy: 0.3 },
  together: { trust: 0.4, joy: 0.2 }, promise: { trust: 0.5 },
  // Fear
  afraid: { fear: 0.7 }, scared: { fear: 0.7 }, terrified: { fear: 0.95 },
  anxious: { fear: 0.5, anticipation: 0.3 }, nervous: { fear: 0.5 },
  worried: { fear: 0.5, anticipation: 0.3 }, panic: { fear: 0.9 },
  dread: { fear: 0.7, anticipation: 0.3 }, horror: { fear: 0.8, surprise: 0.3 },
  creepy: { fear: 0.5, disgust: 0.3 }, scary: { fear: 0.6 },
  frightened: { fear: 0.7 }, uneasy: { fear: 0.4 }, alarmed: { fear: 0.6, surprise: 0.4 },
  // Surprise
  surprised: { surprise: 0.7 }, shocked: { surprise: 0.8 }, astonished: { surprise: 0.8 },
  unexpected: { surprise: 0.6 }, wow: { surprise: 0.6, joy: 0.3 }, whoa: { surprise: 0.6 },
  unbelievable: { surprise: 0.7 }, suddenly: { surprise: 0.4 }, omg: { surprise: 0.6 },
  really: { surprise: 0.2 }, seriously: { surprise: 0.3 }, incredible: { surprise: 0.5, joy: 0.3 },
  // Sadness
  sad: { sadness: 0.7 }, unhappy: { sadness: 0.6 }, depressed: { sadness: 0.8 },
  miserable: { sadness: 0.8 }, heartbroken: { sadness: 0.9 }, lonely: { sadness: 0.6 },
  grief: { sadness: 0.9 }, mourn: { sadness: 0.8 }, cry: { sadness: 0.6 },
  tears: { sadness: 0.5 }, sorry: { sadness: 0.4, trust: 0.2 }, miss: { sadness: 0.5, anticipation: 0.2 },
  lost: { sadness: 0.5 }, hopeless: { sadness: 0.7, fear: 0.3 }, gloomy: { sadness: 0.5 },
  disappointed: { sadness: 0.5, surprise: 0.2 }, melancholy: { sadness: 0.6 },
  // Disgust
  disgusting: { disgust: 0.8 }, gross: { disgust: 0.6 }, nasty: { disgust: 0.6, anger: 0.2 },
  revolting: { disgust: 0.8 }, awful: { disgust: 0.5, sadness: 0.3 }, terrible: { disgust: 0.4, anger: 0.3 },
  hate: { disgust: 0.5, anger: 0.5 }, loathe: { disgust: 0.8 }, yuck: { disgust: 0.6 },
  ew: { disgust: 0.5 }, repulsive: { disgust: 0.8 }, vile: { disgust: 0.7 },
  toxic: { disgust: 0.5, anger: 0.3 }, cringe: { disgust: 0.5 },
  // Anger
  angry: { anger: 0.7 }, furious: { anger: 0.9 }, mad: { anger: 0.6 },
  rage: { anger: 0.95 }, frustrated: { anger: 0.5, sadness: 0.2 }, annoyed: { anger: 0.4 },
  irritated: { anger: 0.5 }, outraged: { anger: 0.8 }, livid: { anger: 0.9 },
  hostile: { anger: 0.6, disgust: 0.3 }, aggressive: { anger: 0.6 }, damn: { anger: 0.4 },
  ugh: { anger: 0.3, disgust: 0.3 }, ridiculous: { anger: 0.4, surprise: 0.2 },
  unfair: { anger: 0.5, sadness: 0.3 }, stupid: { anger: 0.4, disgust: 0.3 },
  // Anticipation
  waiting: { anticipation: 0.5 }, expect: { anticipation: 0.5 }, hope: { anticipation: 0.5, joy: 0.3 },
  eager: { anticipation: 0.7, joy: 0.3 }, curious: { anticipation: 0.6, surprise: 0.2 },
  wonder: { anticipation: 0.5, surprise: 0.3 }, plan: { anticipation: 0.5 },
  soon: { anticipation: 0.4 }, ready: { anticipation: 0.5, trust: 0.2 },
  looking: { anticipation: 0.3 }, forward: { anticipation: 0.4 },
  maybe: { anticipation: 0.3 }, perhaps: { anticipation: 0.3 }, imagine: { anticipation: 0.5, joy: 0.2 },
  prepare: { anticipation: 0.5 }, upcoming: { anticipation: 0.5 },
  // Mixed / strong signals
  help: { fear: 0.3, trust: 0.3 }, please: { anticipation: 0.2, trust: 0.2 },
  thanks: { joy: 0.3, trust: 0.4 }, thank: { joy: 0.3, trust: 0.4 },
  welcome: { joy: 0.3, trust: 0.3 }, goodbye: { sadness: 0.3, anticipation: 0.2 },
  hello: { joy: 0.3, trust: 0.2 }, hi: { joy: 0.2 },
  okay: { trust: 0.2 }, ok: { trust: 0.2 }, sure: { trust: 0.3 },
  no: { anger: 0.2, sadness: 0.1 }, yes: { joy: 0.2, trust: 0.2 },
  wrong: { anger: 0.3, sadness: 0.2 }, right: { trust: 0.3, joy: 0.1 },
  danger: { fear: 0.7 }, careful: { fear: 0.3, anticipation: 0.3 },
  perfect: { joy: 0.6, trust: 0.3 }, broken: { sadness: 0.5, anger: 0.3 },
  gentle: { trust: 0.4, joy: 0.2 }, kind: { trust: 0.5, joy: 0.3 },
  harsh: { anger: 0.4, disgust: 0.2 }, warm: { joy: 0.4, trust: 0.3 },
  cold: { sadness: 0.3, fear: 0.2 }, dark: { fear: 0.3, sadness: 0.3 },
  bright: { joy: 0.4, surprise: 0.2 }, calm: { trust: 0.4 },
  chaos: { fear: 0.4, anger: 0.3, surprise: 0.3 }, peace: { trust: 0.5, joy: 0.3 },
};

// ── Stream Emotion Analyzer ──────────────────────────────────────────────────

const WORD_RE = /[a-z']+/g;
const TOKEN_WINDOW = 30; // analyze every N tokens
const EMA_ALPHA = 0.3;   // smoothing factor (0 = no change, 1 = instant snap)

export class StreamEmotionAnalyzer {
  private tokenCount = 0;
  private buffer = "";
  private current: EmotionVector;
  private conversationId: string;

  constructor(conversationId: string, initial?: EmotionVector) {
    this.conversationId = conversationId;
    this.current = initial ?? zeroVector();
  }

  /** Feed streaming tokens. Automatically analyzes and broadcasts periodically. */
  push(token: string): void {
    this.buffer += token;
    this.tokenCount++;

    if (this.tokenCount % TOKEN_WINDOW === 0) {
      this.analyze();
    }
  }

  /** Flush remaining buffer at end of stream. */
  flush(): void {
    if (this.buffer.length > 0) {
      this.analyze();
    }
  }

  private analyze(): void {
    const text = this.buffer.toLowerCase();
    this.buffer = "";

    const sample = zeroVector();
    let hits = 0;

    // Lexicon scan
    const words = text.match(WORD_RE);
    if (words) {
      for (const w of words) {
        const entry = EMOTION_LEXICON[w];
        if (entry) {
          hits++;
          for (const k of EMOTION_KEYS) {
            if (entry[k]) sample[k] += entry[k];
          }
        }
      }
    }

    // Punctuation signals
    const exclamations = (text.match(/!/g) || []).length;
    const questions = (text.match(/\?/g) || []).length;
    const capsWords = (text.match(/\b[A-Z]{2,}\b/g) || []).length;
    const ellipses = (text.match(/\.{3,}/g) || []).length;

    if (exclamations > 0) { sample.surprise += 0.15 * exclamations; sample.joy += 0.1 * exclamations; hits++; }
    if (questions > 0) { sample.anticipation += 0.15 * questions; hits++; }
    if (capsWords > 0) { sample.anger += 0.2 * capsWords; hits++; }
    if (ellipses > 0) { sample.sadness += 0.1 * ellipses; sample.anticipation += 0.1 * ellipses; hits++; }

    // No signal — don't update
    if (hits === 0) return;

    // Normalize sample to 0–1 range
    let maxVal = 0;
    for (const k of EMOTION_KEYS) { if (sample[k] > maxVal) maxVal = sample[k]; }
    if (maxVal > 1) {
      for (const k of EMOTION_KEYS) { sample[k] /= maxVal; }
    }

    // EMA smooth into current vector
    for (const k of EMOTION_KEYS) {
      this.current[k] = this.current[k] * (1 - EMA_ALPHA) + sample[k] * EMA_ALPHA;
    }

    // Broadcast
    broadcastEvent("emotion", { ...this.current, conversationId: this.conversationId });
  }
}

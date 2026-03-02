// =============================================================================
// Aelora Scoring Engine — Pure Functions (no I/O, no network calls)
//
// Score = Urgency(0–35) + Impact(0–30) + Effort(0–20) + Context(0–15) → 0–100
//
// Scientific basis:
//   Urgency  — Hyperbolic discounting (Loewenstein & Prelec 1992)
//   Impact   — MCDA consequence analysis + reversibility theory
//   Effort   — SMEQ (Zijlstra 1993) × WSJF throughput principle
//   Context  — EMA adaptive learning + streak gamification
// =============================================================================

// ============================================================
// Types
// ============================================================

export type LifeCategory = "tasks" | "health" | "finance" | "social" | "work";

export type ScoreInput = {
  // Identity
  title: string;
  description?: string;
  category?: LifeCategory;

  // Timing
  dueDate?: string | null;       // ISO 8601 — used to compute hoursUntilDue
  completedAt?: string | null;   // If set, treat as "now" for urgency calc
  nowMs?: number;                // Override "now" for testing

  // Impact
  priority?: "low" | "medium" | "high";
  impactLevel?: "trivial" | "low" | "moderate" | "high" | "critical";
  irreversible?: boolean;
  affectsOthers?: boolean;

  // Effort (SMEQ input hierarchy — first available wins)
  smeqEstimate?: number | null;   // 0–150, user-set slider
  estimatedMinutes?: number | null;
  sizeLabel?: "micro" | "small" | "medium" | "large" | "epic" | null;

  // Context (adaptive)
  streak?: number;                // current streak in days
  completionsLast24h?: number;    // momentum
  personalBias?: number;          // from category_stats.personal_bias (0.8–1.2)
  categoryCompletionCount?: number; // require ≥3 before bias affects score
  avgSmeqActual?: number | null;  // from category_stats for fallback SMEQ
};

export type ScoreBreakdown = {
  total: number;           // 0–100
  urgency: number;         // 0–35
  impact: number;          // 0–30
  effort: number;          // 0–20
  context: number;         // 0–15
  smeqUsed: number;        // SMEQ value that was actually used
  hoursUntilDue: number | null;
  inferredCategory: LifeCategory;
  inferredIrreversible: boolean;
  inferredAffectsOthers: boolean;
};

export type CompletionResult = {
  scoreBreakdown: ScoreBreakdown;
  pointsAwarded: number;
  newAchievements: string[];
  updatedStreak: number;
  updatedLongestStreak: number;
  lastCompletionDate: string;
  emaUpdates: {
    avgScore: number;
    avgHoursToComplete: number;
    avgSmeqActual?: number;  // only when smeqActual provided
    personalBias: number;
  };
};

export type UserState = {
  totalPoints: number;
  currentStreak: number;
  longestStreak: number;
  lastCompletionDate: string | null;  // YYYY-MM-DD
  categoryStats?: {
    completionCount: number;
    avgScore: number;
    avgHoursToComplete: number;
    avgSmeqActual: number;
    personalBias: number;
  };
  achievements?: string[];
};

// ============================================================
// Keyword Inference
// ============================================================

const CATEGORY_KEYWORDS: Record<LifeCategory, string[]> = {
  health:  ["doctor", "appointment", "gym", "medicine", "workout", "dentist", "therapy", "prescription", "checkup", "surgery", "hospital", "clinic", "exercise", "run", "yoga", "physio"],
  finance: ["bill", "payment", "invoice", "tax", "bank", "rent", "mortgage", "budget", "savings", "insurance", "loan", "credit", "invest", "expense", "receipt"],
  social:  ["birthday", "anniversary", "gift", "family", "friend", "party", "dinner", "wedding", "reunion", "date", "social", "gathering", "celebrate", "visit"],
  work:    ["meeting", "project", "report", "client", "deadline", "pr", "code", "review", "deploy", "presentation", "interview", "standup", "sprint", "ticket", "email"],
  tasks:   [],  // default
};

const IRREVERSIBLE_KEYWORDS = [
  "birthday", "anniversary", "appointment", "flight", "exam", "interview",
  "presentation", "surgery", "deadline", "wedding", "graduation", "expir",
];

const AFFECTS_OTHERS_KEYWORDS = [
  "meeting", "team", "client", "review", "present", "submit", "friend",
  "family", "gift", "party", "together", "group", "collaborate", "share",
];

const SMEQ_HINT_KEYWORDS: Array<{ words: string[]; smeq: number }> = [
  { words: ["quick", "fast", "brief", "simple", "easy"], smeq: 10 },
  { words: ["short", "small", "minor"],                  smeq: 35 },
  { words: ["long", "all day", "complex", "hard", "difficult", "complicated"], smeq: 110 },
  { words: ["huge", "massive", "enormous", "overwhelming"],                    smeq: 130 },
];

function haystack(input: ScoreInput): string {
  return `${input.title} ${input.description ?? ""}`.toLowerCase();
}

export function inferCategory(input: ScoreInput): LifeCategory {
  if (input.category) return input.category;
  const text = haystack(input);
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS) as [LifeCategory, string[]][]) {
    if (cat === "tasks") continue;
    if (keywords.some((kw) => text.includes(kw))) return cat;
  }
  return "tasks";
}

export function inferIrreversible(input: ScoreInput): boolean {
  if (input.irreversible !== undefined) return input.irreversible;
  const text = haystack(input);
  return IRREVERSIBLE_KEYWORDS.some((kw) => text.includes(kw));
}

export function inferAffectsOthers(input: ScoreInput): boolean {
  if (input.affectsOthers !== undefined) return input.affectsOthers;
  const text = haystack(input);
  return AFFECTS_OTHERS_KEYWORDS.some((kw) => text.includes(kw));
}

/** Infer SMEQ from estimatedMinutes (linear mapping) */
export function minutesToSmeq(minutes: number): number {
  if (minutes < 5)   return 5;
  if (minutes < 30)  return 35;
  if (minutes < 120) return 65;
  if (minutes < 480) return 95;
  return 130;
}

/** Infer SMEQ from size_label */
const SIZE_LABEL_SMEQ: Record<string, number> = {
  micro: 10,
  small: 35,
  medium: 65,
  large: 95,
  epic: 130,
};

/** Priority → impact_level fallback */
const PRIORITY_TO_IMPACT: Record<string, "trivial" | "low" | "moderate" | "high" | "critical"> = {
  low: "low",
  medium: "moderate",
  high: "high",
};

/**
 * Resolve SMEQ using the priority hierarchy:
 * smeq_estimate → estimated_minutes → size_label → keyword hints → avg_smeq_actual → default 65
 */
export function resolveSmeq(input: ScoreInput): number {
  if (input.smeqEstimate != null) return Math.max(0, Math.min(150, input.smeqEstimate));
  if (input.estimatedMinutes != null) return minutesToSmeq(input.estimatedMinutes);
  if (input.sizeLabel)  return SIZE_LABEL_SMEQ[input.sizeLabel] ?? 65;

  // Keyword hints from title/description
  const text = haystack(input);
  for (const { words, smeq } of SMEQ_HINT_KEYWORDS) {
    if (words.some((w) => text.includes(w))) return smeq;
  }

  // Adaptive category baseline
  if (input.avgSmeqActual != null) return input.avgSmeqActual;

  return 65; // default: moderate effort
}

// ============================================================
// Dimension 1 — Urgency (0–35)
// Hyperbolic discounting: 35 × e^(-0.013 × hoursUntilDue)
// ============================================================

/** Returns hours until due from "now". Negative = overdue. */
export function computeHoursUntilDue(
  dueDate?: string | null,
  nowMs = Date.now(),
): number | null {
  if (!dueDate) return null;
  const due = new Date(dueDate).getTime();
  return (due - nowMs) / 3_600_000;
}

export function computeUrgency(hoursUntilDue: number | null): number {
  if (hoursUntilDue === null) return 18;  // neutral — no deadline
  if (hoursUntilDue <= 0)    return 35;  // overdue — max urgency

  const raw = 35 * Math.exp(-0.013 * hoursUntilDue);
  return Math.round(Math.max(0, Math.min(35, raw)));
}

// ============================================================
// Dimension 2 — Impact (0–30)
// MCDA consequence analysis + reversibility + social obligation
// ============================================================

const IMPACT_LEVEL_SCORES: Record<string, number> = {
  trivial:  5,
  low:      10,
  moderate: 17,
  high:     24,
  critical: 30,
};

export function computeImpact(
  impactLevel: "trivial" | "low" | "moderate" | "high" | "critical" | null | undefined,
  priority: "low" | "medium" | "high" | null | undefined,
  irreversible: boolean,
  affectsOthers: boolean,
): number {
  const level = impactLevel ?? PRIORITY_TO_IMPACT[priority ?? "medium"] ?? "moderate";
  let score = IMPACT_LEVEL_SCORES[level] ?? 17;
  if (irreversible)   score += 6;
  if (affectsOthers)  score += 3;
  return Math.min(30, score);
}

// ============================================================
// Dimension 3 — Effort (0–20)
// SMEQ (Zijlstra 1993) × WSJF inverse
// Higher SMEQ (more effort) → lower score (deprioritize until urgent)
// ============================================================

export function computeEffort(smeq: number): number {
  const raw = 20 * (1 - smeq / 150);
  return Math.max(1, Math.round(raw));
}

// ============================================================
// Dimension 4 — Context (0–15)
// EMA adaptive bias + streak gamification + momentum
// ============================================================

function biasToScore(bias: number, completionCount: number): number {
  if (completionCount < 3) return 3; // neutral until we have data
  // personal_bias 0.8..1.2 → maps to 1..5
  const clamped = Math.max(0.8, Math.min(1.2, bias));
  return Math.round(1 + (clamped - 0.8) / 0.4 * 4);
}

function streakToScore(streak: number): number {
  if (streak >= 30) return 5;
  if (streak >= 14) return 4;
  if (streak >= 7)  return 3;
  if (streak >= 3)  return 2;
  if (streak >= 1)  return 1;
  return 0;
}

function momentumToScore(completionsLast24h: number): number {
  if (completionsLast24h >= 5) return 5;
  if (completionsLast24h >= 3) return 3;
  if (completionsLast24h >= 1) return 1;
  return 0;
}

export function computeContext(
  streak = 0,
  completionsLast24h = 0,
  personalBias = 1.0,
  categoryCompletionCount = 0,
): number {
  const bias     = biasToScore(personalBias, categoryCompletionCount);
  const streakS  = streakToScore(streak);
  const momentum = momentumToScore(completionsLast24h);
  return Math.min(15, bias + streakS + momentum);
}

// ============================================================
// Main scoring function
// ============================================================

export function scoreTask(input: ScoreInput): ScoreBreakdown {
  const nowMs           = input.nowMs ?? Date.now();
  const hoursUntilDue   = computeHoursUntilDue(input.dueDate, nowMs);
  const smeqUsed        = resolveSmeq(input);
  const inferredCat     = inferCategory(input);
  const inferredIrrev   = inferIrreversible(input);
  const inferredAffects = inferAffectsOthers(input);

  const urgency = computeUrgency(hoursUntilDue);
  const impact  = computeImpact(input.impactLevel, input.priority, inferredIrrev, inferredAffects);
  const effort  = computeEffort(smeqUsed);
  const context = computeContext(
    input.streak,
    input.completionsLast24h,
    input.personalBias,
    input.categoryCompletionCount,
  );

  return {
    total: urgency + impact + effort + context,
    urgency,
    impact,
    effort,
    context,
    smeqUsed,
    hoursUntilDue,
    inferredCategory:      inferredCat,
    inferredIrreversible:  inferredIrrev,
    inferredAffectsOthers: inferredAffects,
  };
}

// ============================================================
// Points / XP System
// ============================================================

/**
 * Compute points awarded for a completed task.
 * basePoints = 10 + (score/100) × 90  →  10–100
 * streakMultiplier = 1.0× at streak=0, 2.0× at streak=30+
 * overdueBonus = 1.25× if completed overdue
 */
export function computePointsAwarded(
  score: number,
  streak: number,
  isOverdue: boolean,
): number {
  const basePoints       = 10 + (score / 100) * 90;
  const streakMultiplier = 1 + Math.min(streak, 30) / 30;
  const overdueBonus     = isOverdue ? 1.25 : 1.0;
  return Math.round(basePoints * streakMultiplier * overdueBonus);
}

// ============================================================
// Streak logic
// ============================================================

/**
 * Compute updated streak given the last completion date and today's date.
 * Rules:
 *  - Same day as lastCompletion → streak unchanged
 *  - Yesterday → streak + 1
 *  - Gap > 1 day → streak resets to 1
 *  - No prior completion → streak = 1
 */
export function computeStreak(
  currentStreak: number,
  lastCompletionDate: string | null,
  todayDate: string,  // YYYY-MM-DD
): number {
  if (!lastCompletionDate) return 1;
  if (lastCompletionDate === todayDate) return currentStreak;

  const last  = new Date(lastCompletionDate);
  const today = new Date(todayDate);
  const diffDays = Math.round((today.getTime() - last.getTime()) / 86_400_000);

  if (diffDays === 1) return currentStreak + 1;
  return 1;  // gap > 1 day — reset
}

// ============================================================
// EMA adaptive learning (α = 0.2)
// ============================================================

const EMA_ALPHA = 0.2;

export function emaUpdate(prev: number, newValue: number): number {
  return prev * (1 - EMA_ALPHA) + newValue * EMA_ALPHA;
}

/** Compute new personal_bias from global and category average hours. Clamped 0.8–1.2. */
export function computePersonalBias(
  globalAvgHours: number,
  categoryAvgHours: number,
): number {
  if (categoryAvgHours <= 0) return 1.0;
  const ratio = globalAvgHours / categoryAvgHours;
  return Math.max(0.8, Math.min(1.2, ratio));
}

// ============================================================
// Achievement definitions
// ============================================================

export type AchievementDef = {
  id: string;
  name: string;
  description: string;
};

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: "first_task",     name: "First Steps",        description: "Complete your first task" },
  { id: "ten_tasks",      name: "Getting Momentum",   description: "Complete 10 tasks" },
  { id: "hundred_tasks",  name: "Century Club",        description: "Complete 100 tasks" },
  { id: "streak_3",       name: "Three-Day Streak",   description: "Maintain a 3-day streak" },
  { id: "streak_7",       name: "One-Week Warrior",   description: "Maintain a 7-day streak" },
  { id: "streak_30",      name: "Monthly Master",     description: "Maintain a 30-day streak" },
  { id: "thousand_points",name: "Point Millionaire",  description: "Earn 1000 total points" },
  { id: "high_scorer",    name: "High Scorer",        description: "Score 90+ on a single task" },
  { id: "overdue_hero",   name: "Overdue Hero",       description: "Complete an overdue task" },
];

/**
 * Check which achievements were just unlocked given new state.
 * Returns only newly unlocked IDs (not already in existing set).
 */
export function checkAchievements(params: {
  totalCompletions: number;
  totalPoints: number;
  streak: number;
  score: number;
  isOverdue: boolean;
  existingAchievements: string[];
}): string[] {
  const { totalCompletions, totalPoints, streak, score, isOverdue, existingAchievements } = params;
  const existing = new Set(existingAchievements);
  const newlyUnlocked: string[] = [];

  const check = (id: string, condition: boolean) => {
    if (condition && !existing.has(id)) newlyUnlocked.push(id);
  };

  check("first_task",      totalCompletions >= 1);
  check("ten_tasks",       totalCompletions >= 10);
  check("hundred_tasks",   totalCompletions >= 100);
  check("streak_3",        streak >= 3);
  check("streak_7",        streak >= 7);
  check("streak_30",       streak >= 30);
  check("thousand_points", totalPoints >= 1000);
  check("high_scorer",     score >= 90);
  check("overdue_hero",    isOverdue);

  return newlyUnlocked;
}

// ============================================================
// Full completion pipeline (pure — caller handles persistence)
// ============================================================

/**
 * Process a task completion and return all derived values.
 * The caller is responsible for persisting results to Supabase.
 *
 * @param input         Scoring inputs for the task
 * @param userState     Current user state from Supabase
 * @param smeqActual    Optional post-completion SMEQ self-report (0–150)
 * @param globalAvgHoursToComplete  Used to compute personal_bias
 */
export function processCompletion(
  input: ScoreInput,
  userState: UserState,
  smeqActual?: number | null,
  globalAvgHoursToComplete = 24,
): CompletionResult {
  const nowMs    = input.nowMs ?? Date.now();
  const todayStr = new Date(nowMs).toISOString().slice(0, 10);

  const breakdown = scoreTask(input);
  const isOverdue = breakdown.hoursUntilDue !== null && breakdown.hoursUntilDue < 0;

  const newStreak        = computeStreak(userState.currentStreak, userState.lastCompletionDate, todayStr);
  const newLongestStreak = Math.max(userState.longestStreak, newStreak);
  const pointsAwarded    = computePointsAwarded(breakdown.total, newStreak, isOverdue);
  const newTotalPoints   = userState.totalPoints + pointsAwarded;

  // EMA updates for category stats
  const prev = userState.categoryStats ?? {
    completionCount: 0,
    avgScore: 50,
    avgHoursToComplete: 24,
    avgSmeqActual: 65,
    personalBias: 1.0,
  };

  const hoursToComplete = breakdown.hoursUntilDue != null
    ? Math.max(0, -breakdown.hoursUntilDue)  // hours it was overdue → proxy for completion time
    : 0;

  const newAvgScore             = emaUpdate(prev.avgScore, breakdown.total);
  const newAvgHoursToComplete   = emaUpdate(prev.avgHoursToComplete, hoursToComplete);
  const newAvgSmeqActual        = smeqActual != null ? emaUpdate(prev.avgSmeqActual, smeqActual) : undefined;
  const newPersonalBias         = computePersonalBias(globalAvgHoursToComplete, newAvgHoursToComplete);

  const totalCompletions = (prev.completionCount ?? 0) + 1;

  const newAchievements = checkAchievements({
    totalCompletions,
    totalPoints: newTotalPoints,
    streak: newStreak,
    score: breakdown.total,
    isOverdue,
    existingAchievements: userState.achievements ?? [],
  });

  return {
    scoreBreakdown: breakdown,
    pointsAwarded,
    newAchievements,
    updatedStreak: newStreak,
    updatedLongestStreak: newLongestStreak,
    lastCompletionDate: todayStr,
    emaUpdates: {
      avgScore: newAvgScore,
      avgHoursToComplete: newAvgHoursToComplete,
      ...(newAvgSmeqActual != null ? { avgSmeqActual: newAvgSmeqActual } : {}),
      personalBias: newPersonalBias,
    },
  };
}

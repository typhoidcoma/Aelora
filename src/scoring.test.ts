// =============================================================================
// Aelora Scoring Engine — Unit Tests
// Run with: npx tsx src/scoring.test.ts
// =============================================================================

import {
  computeUrgency,
  computeImpact,
  computeEffort,
  computeContext,
  computePointsAwarded,
  computeStreak,
  emaUpdate,
  computePersonalBias,
  checkAchievements,
  scoreTask,
  resolveSmeq,
  inferCategory,
  inferIrreversible,
  inferAffectsOthers,
  minutesToSmeq,
  processCompletion,
  type ScoreInput,
  type UserState,
} from "./scoring.js";

// ============================================================
// Minimal test harness
// ============================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, actual?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}${actual !== undefined ? ` (got: ${JSON.stringify(actual)})` : ""}`);
    failed++;
  }
}

function approx(actual: number, expected: number, tolerance = 2): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function section(name: string): void {
  console.log(`\n─── ${name} ─────────────────────────────────`);
}

// ============================================================
// Urgency Tests
// ============================================================

section("Urgency (0–35)");

assert(computeUrgency(null) === 18, "No deadline → 18 (neutral)");
assert(computeUrgency(0) === 35, "Exactly at deadline → 35 (max)");
assert(computeUrgency(-1) === 35, "Overdue → 35 (max)");
assert(computeUrgency(-100) === 35, "Very overdue → 35 (max)");
assert(approx(computeUrgency(1), 35), "1h until due ≈ 35", computeUrgency(1));
assert(approx(computeUrgency(12), 30), "12h until due ≈ 30", computeUrgency(12));
assert(approx(computeUrgency(24), 25), "1 day until due ≈ 25", computeUrgency(24));
assert(approx(computeUrgency(72), 16), "3 days until due ≈ 16", computeUrgency(72));
assert(approx(computeUrgency(168), 4), "7 days until due ≈ 4", computeUrgency(168));
assert(computeUrgency(24 * 30) < 2, "30 days until due < 2", computeUrgency(24 * 30));

// ============================================================
// Impact Tests
// ============================================================

section("Impact (0–30)");

assert(computeImpact("trivial",  undefined, false, false) === 5,  "trivial → 5");
assert(computeImpact("low",      undefined, false, false) === 10, "low → 10");
assert(computeImpact("moderate", undefined, false, false) === 17, "moderate → 17");
assert(computeImpact("high",     undefined, false, false) === 24, "high → 24");
assert(computeImpact("critical", undefined, false, false) === 30, "critical → 30");
assert(computeImpact("high",     undefined, true,  false) === 30, "high + irreversible → 30 (capped)");
assert(computeImpact("moderate", undefined, true,  false) === 23, "moderate + irreversible → 23");
assert(computeImpact("moderate", undefined, false, true)  === 20, "moderate + affects_others → 20");
assert(computeImpact("moderate", undefined, true,  true)  === 26, "moderate + both → 26");
assert(computeImpact("critical", undefined, true,  true)  === 30, "critical + both → 30 (capped)");

// Priority fallback
assert(computeImpact(undefined, "low",    false, false) === 10, "priority=low → low=10");
assert(computeImpact(undefined, "medium", false, false) === 17, "priority=medium → moderate=17");
assert(computeImpact(undefined, "high",   false, false) === 24, "priority=high → high=24");
assert(computeImpact(undefined, undefined,false, false) === 17, "no impact/priority → moderate=17");

// ============================================================
// Effort (SMEQ) Tests
// ============================================================

section("Effort / SMEQ (0–20)");

assert(computeEffort(0)   === 20, "SMEQ=0 → 20 (effortless)");
assert(computeEffort(75)  === 10, "SMEQ=75 → 10");
assert(computeEffort(150) === 1,  "SMEQ=150 → 1 (extreme)");
assert(computeEffort(35)  === 15, "SMEQ=35 → 15 (small effort)");
assert(computeEffort(65)  === 11, "SMEQ=65 → ~11 (moderate)");
assert(computeEffort(110) === 5,  "SMEQ=110 → 5 (exceptional)");

section("SMEQ resolution");

assert(resolveSmeq({ title: "test", smeqEstimate: 50 }) === 50, "smeq_estimate wins");
assert(resolveSmeq({ title: "test", smeqEstimate: 50, estimatedMinutes: 5 }) === 50, "smeq_estimate beats minutes");
assert(resolveSmeq({ title: "test", estimatedMinutes: 3 }) === 5,   "< 5 min → SMEQ 5");
assert(resolveSmeq({ title: "test", estimatedMinutes: 20 }) === 35,  "< 30 min → SMEQ 35");
assert(resolveSmeq({ title: "test", estimatedMinutes: 90 }) === 65,  "< 120 min → SMEQ 65");
assert(resolveSmeq({ title: "test", estimatedMinutes: 300 }) === 95, "< 480 min → SMEQ 95");
assert(resolveSmeq({ title: "test", estimatedMinutes: 600 }) === 130,"≥ 480 min → SMEQ 130");
assert(resolveSmeq({ title: "test", sizeLabel: "micro" })   === 10, "micro → SMEQ 10");
assert(resolveSmeq({ title: "test", sizeLabel: "small" })   === 35, "small → SMEQ 35");
assert(resolveSmeq({ title: "test", sizeLabel: "medium" })  === 65, "medium → SMEQ 65");
assert(resolveSmeq({ title: "test", sizeLabel: "large" })   === 95, "large → SMEQ 95");
assert(resolveSmeq({ title: "test", sizeLabel: "epic" })    === 130,"epic → SMEQ 130");
assert(resolveSmeq({ title: "quick errand" })                === 10, "keyword 'quick' → SMEQ 10");
assert(resolveSmeq({ title: "complex migration" })           === 110,"keyword 'complex' → SMEQ 110");
assert(resolveSmeq({ title: "test", avgSmeqActual: 80 })     === 80, "category avg_smeq_actual fallback");
assert(resolveSmeq({ title: "grocery run" })                 === 65, "no hints → default 65");

// ============================================================
// Context Tests
// ============================================================

section("Context (0–15)");

assert(computeContext(0, 0, 1.0, 0) === 3, "baseline (no streak, no momentum, no data) → 3 bias");
assert(computeContext(3, 0, 1.0, 5) === 5, "streak=3 → +2 streakScore, total≈5");
assert(computeContext(7, 0, 1.0, 5) === 6, "streak=7 → +3 streakScore, total≈6");
assert(computeContext(30, 5, 1.2, 10) === 15, "max streak + max momentum + max bias → 15 (capped)");
assert(computeContext(0, 1, 1.0, 5) === 4, "momentum=1 → +1");
assert(computeContext(0, 3, 1.0, 5) === 6, "momentum=3 → +3");
assert(computeContext(0, 5, 1.0, 5) === 8, "momentum=5 → +5");

// ============================================================
// Keyword Inference Tests
// ============================================================

section("Keyword Inference");

assert(inferCategory({ title: "Doctor appointment" }) === "health", "doctor → health");
assert(inferCategory({ title: "Pay rent" }) === "finance", "rent → finance");
assert(inferCategory({ title: "Birthday party" }) === "social", "birthday → social");
assert(inferCategory({ title: "Team meeting" }) === "work", "meeting → work");
assert(inferCategory({ title: "Clean desk" }) === "tasks", "no match → tasks");
assert(inferCategory({ title: "Doctor", category: "work" }) === "work", "explicit category wins");

assert(inferIrreversible({ title: "Birthday gift for Sarah" }) === true, "birthday → irreversible");
assert(inferIrreversible({ title: "Buy groceries" }) === false, "groceries → not irreversible");
assert(inferIrreversible({ title: "Job interview" }) === true, "interview → irreversible");
assert(inferIrreversible({ title: "Meeting", irreversible: false }) === false, "explicit false wins");

assert(inferAffectsOthers({ title: "Team meeting" }) === true, "team → affects others");
assert(inferAffectsOthers({ title: "Do laundry" }) === false, "laundry → not affects others");
assert(inferAffectsOthers({ title: "Birthday gift" }) === true, "gift → affects others");

// ============================================================
// Points / XP Tests
// ============================================================

section("Points / XP");

assert(computePointsAwarded(0, 0, false)   === 10,  "score=0, no streak → 10 base");
assert(computePointsAwarded(100, 0, false) === 100, "score=100, no streak → 100 base");
assert(computePointsAwarded(50, 30, false) === 110, "score=50, streak=30 → 110 (2× multiplier on 55 base)");
assert(computePointsAwarded(100, 0, true)  === 125, "score=100, overdue → 125 (1.25×)");
assert(computePointsAwarded(0, 30, true)   === 25,  "score=0, streak=30, overdue → 25");

// ============================================================
// Streak Tests
// ============================================================

section("Streak logic");

assert(computeStreak(0, null, "2025-01-15") === 1, "first completion → streak 1");
assert(computeStreak(5, "2025-01-14", "2025-01-15") === 6, "consecutive day → +1");
assert(computeStreak(5, "2025-01-13", "2025-01-15") === 1, "gap of 2 days → reset to 1");
assert(computeStreak(5, "2025-01-15", "2025-01-15") === 5, "same day → no change");
assert(computeStreak(7, "2025-01-08", "2025-01-15") === 1, "gap of 7 days → reset to 1");

// ============================================================
// EMA Tests
// ============================================================

section("EMA (α=0.2)");

assert(Math.abs(emaUpdate(50, 50) - 50) < 0.01, "stable input → no change");
assert(Math.abs(emaUpdate(50, 100) - 60) < 0.01, "single step toward 100");
assert(emaUpdate(50, 0) === 40, "step toward 0");

assert(Math.abs(computePersonalBias(24, 24) - 1.0) < 0.01, "equal hours → bias 1.0");
assert(computePersonalBias(24, 48) === 0.8, "fast category → bias 0.8 (clamped)");
assert(computePersonalBias(24, 8) === 1.2,  "slow category → bias 1.2 (clamped)");

// ============================================================
// Achievement Tests
// ============================================================

section("Achievements");

const noAchievements: string[] = [];
assert(
  checkAchievements({ totalCompletions: 1, totalPoints: 10, streak: 1, score: 50, isOverdue: false, existingAchievements: noAchievements }).includes("first_task"),
  "first completion → first_task",
);
assert(
  checkAchievements({ totalCompletions: 10, totalPoints: 100, streak: 1, score: 50, isOverdue: false, existingAchievements: noAchievements }).includes("ten_tasks"),
  "10 completions → ten_tasks",
);
assert(
  checkAchievements({ totalCompletions: 1, totalPoints: 10, streak: 7, score: 50, isOverdue: false, existingAchievements: noAchievements }).includes("streak_7"),
  "streak 7 → streak_7",
);
assert(
  checkAchievements({ totalCompletions: 1, totalPoints: 10, streak: 1, score: 92, isOverdue: false, existingAchievements: noAchievements }).includes("high_scorer"),
  "score 92 → high_scorer",
);
assert(
  checkAchievements({ totalCompletions: 1, totalPoints: 10, streak: 1, score: 50, isOverdue: true, existingAchievements: noAchievements }).includes("overdue_hero"),
  "overdue → overdue_hero",
);
// Already unlocked should not re-fire
assert(
  !checkAchievements({ totalCompletions: 1, totalPoints: 10, streak: 1, score: 50, isOverdue: false, existingAchievements: ["first_task"] }).includes("first_task"),
  "already unlocked → not returned again",
);

// ============================================================
// Full scoreTask() Worked Examples (from the plan)
// ============================================================

section("Worked Examples");

// Fix NOW to a known time for deterministic tests
const NOW_MS = new Date("2025-01-15T12:00:00Z").getTime();

// Example 1: "Buy birthday gift for Sarah"
// high priority, 2 days out, irreversible, affects_others, SMEQ≈35 (quick errand)
const birthday: ScoreInput = {
  title: "Buy birthday gift for Sarah",
  priority: "high",
  dueDate: new Date(NOW_MS + 48 * 3_600_000).toISOString(),
  irreversible: true,
  affectsOthers: true,
  smeqEstimate: 35,
  streak: 7,
  completionsLast24h: 2,
  personalBias: 1.0,
  categoryCompletionCount: 5,
  nowMs: NOW_MS,
};
const bdScore = scoreTask(birthday);
console.log(`  Birthday task: total=${bdScore.total}, urgency=${bdScore.urgency}, impact=${bdScore.impact}, effort=${bdScore.effort}, context=${bdScore.context}`);
assert(bdScore.impact === 30, "Birthday: impact capped at 30 (high+irrev+affects)");
assert(bdScore.effort === 15, "Birthday: effort=15 (SMEQ=35)");
assert(bdScore.total >= 60 && bdScore.total <= 75, `Birthday score in 60–75 range`, bdScore.total);

// Example 2: "Mow the lawn" (medium, no deadline, physically 120 min but cognitively easy → SMEQ≈25)
// Note: estimatedMinutes measures physical time, not cognitive effort.
// Mowing is physically long but cognitively trivial — SMEQ must be set directly.
const lawn: ScoreInput = {
  title: "Mow the lawn",
  priority: "medium",
  smeqEstimate: 25,
  streak: 7,
  completionsLast24h: 2,
  personalBias: 1.0,
  categoryCompletionCount: 5,
  nowMs: NOW_MS,
};
const lawnScore = scoreTask(lawn);
console.log(`  Lawn task:     total=${lawnScore.total}, urgency=${lawnScore.urgency}, impact=${lawnScore.impact}, effort=${lawnScore.effort}, context=${lawnScore.context}`);
assert(lawnScore.urgency === 18, "Lawn: urgency=18 (no deadline)");
assert(lawnScore.impact === 17,  "Lawn: impact=17 (moderate, no modifiers)");
assert(lawnScore.total >= 48 && lawnScore.total <= 65, `Lawn score in 48–65 range`, lawnScore.total);

// Example 3: "File quarterly taxes" (high, no deadline, SMEQ≈110)
const taxes: ScoreInput = {
  title: "File quarterly taxes",
  priority: "high",
  smeqEstimate: 110,
  streak: 7,
  completionsLast24h: 2,
  personalBias: 1.0,
  categoryCompletionCount: 5,
  nowMs: NOW_MS,
};
const taxScore = scoreTask(taxes);
console.log(`  Tax task:      total=${taxScore.total}, urgency=${taxScore.urgency}, impact=${taxScore.impact}, effort=${taxScore.effort}, context=${taxScore.context}`);
assert(taxScore.effort === 5, "Taxes: effort=5 (SMEQ=110)");
assert(taxScore.urgency === 18, "Taxes: urgency=18 (no deadline)");
assert(taxScore.total >= 45 && taxScore.total <= 60, `Tax score in 45–60 range`, taxScore.total);

// Key ordering: birthday > lawn > taxes
assert(bdScore.total > lawnScore.total, `Birthday (${bdScore.total}) > Lawn (${lawnScore.total})`);
assert(lawnScore.total > taxScore.total, `Lawn (${lawnScore.total}) > Taxes (${taxScore.total})`);

// ============================================================
// Tax deadline scenario: the crossover happens at ~32h (not 3 days)
// because lawn's SMEQ=25 gives it effort=17 vs taxes' effort=5.
// Taxes beats lawn when urgency_taxes > 59 - 36 = 23, i.e. h < ~32h.
// ============================================================

section("Deadline effect on taxes");

const taxesWith24hDeadline: ScoreInput = {
  ...taxes,
  dueDate: new Date(NOW_MS + 24 * 3_600_000).toISOString(),
};
const taxDue24h = scoreTask(taxesWith24hDeadline);
console.log(`  Taxes (24h deadline): total=${taxDue24h.total}, urgency=${taxDue24h.urgency}`);
assert(taxDue24h.urgency > 20, "24h tax urgency > 20", taxDue24h.urgency);
assert(taxDue24h.total > lawnScore.total, `Taxes at 24h (${taxDue24h.total}) > Lawn (${lawnScore.total})`);

// ============================================================
// processCompletion integration test
// ============================================================

section("processCompletion pipeline");

const userState: UserState = {
  totalPoints: 0,
  currentStreak: 0,
  longestStreak: 0,
  lastCompletionDate: null,
  achievements: [],
  categoryStats: {
    completionCount: 0,
    avgScore: 50,
    avgHoursToComplete: 24,
    avgSmeqActual: 65,
    personalBias: 1.0,
  },
};

const firstTask: ScoreInput = {
  title: "Complete first task",
  priority: "medium",
  nowMs: NOW_MS,
};

const result = processCompletion(firstTask, userState);
assert(result.updatedStreak === 1, "First completion → streak=1");
assert(result.newAchievements.includes("first_task"), "First completion → first_task achievement");
assert(result.pointsAwarded >= 10, `Points awarded ≥ 10 (got ${result.pointsAwarded})`);
assert(result.lastCompletionDate === "2025-01-15", "Completion date is today");
assert(result.scoreBreakdown.total > 0, "Score is non-zero");

// SMEQ reporting
const resultWithSmeq = processCompletion(firstTask, userState, 90);
assert(resultWithSmeq.emaUpdates.avgSmeqActual !== undefined, "EMA SMEQ updated when reported");
assert(approx(resultWithSmeq.emaUpdates.avgSmeqActual!, 70, 1), "EMA SMEQ: 65×0.8 + 90×0.2 = 70", resultWithSmeq.emaUpdates.avgSmeqActual);

// ============================================================
// Summary
// ============================================================

console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n${failed} test(s) failed!`);
  process.exit(1);
} else {
  console.log("\nAll tests passed ✓");
}

import { Cron } from "croner";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { getLLMOneShot } from "./llm.js";
import { sendToChannel } from "./discord.js";

// --- Types ---

export type CronExecutionRecord = {
  timestamp: string;
  success: boolean;
  durationMs: number;
  outputPreview: string;
  error: string | null;
};

export type CronJobState = {
  name: string;
  schedule: string;
  timezone?: string;
  channelId: string;
  type: "static" | "llm";
  message?: string;
  prompt?: string;
  enabled: boolean;
  lastRun: Date | null;
  nextRun: Date | null;
  lastError: string | null;
  history: CronExecutionRecord[];
  instance: Cron | null;
};

type PersistedCronJob = {
  name: string;
  schedule: string;
  timezone?: string;
  channelId: string;
  type: "static" | "llm";
  message?: string;
  prompt?: string;
  enabled: boolean;
  history: CronExecutionRecord[];
};

// --- Constants ---

const CRON_JOBS_FILE = "data/cron-jobs.json";
const MAX_HISTORY = 10;
const OUTPUT_PREVIEW_LENGTH = 300;

// --- State ---

export const cronJobs: CronJobState[] = [];

// --- Persistence ---

function loadPersistedJobs(): PersistedCronJob[] {
  try {
    if (existsSync(CRON_JOBS_FILE)) {
      return JSON.parse(readFileSync(CRON_JOBS_FILE, "utf-8"));
    }
  } catch {
    console.warn("Cron: failed to read persisted jobs, starting fresh");
  }
  return [];
}

function savePersistedJobs(deletedName?: string): void {
  // Merge with existing file to prevent data loss if the in-memory array
  // is incomplete (can happen on Windows due to ESM module duplication).
  const existing = loadPersistedJobs();
  const merged = new Map(existing.map((j) => [j.name, j]));

  // Update/add from in-memory jobs
  for (const j of cronJobs) {
    merged.set(j.name, {
      name: j.name,
      schedule: j.schedule,
      timezone: j.timezone,
      channelId: j.channelId,
      type: j.type,
      message: j.message,
      prompt: j.prompt,
      enabled: j.enabled,
      history: j.history,
    });
  }

  // Remove explicitly deleted job
  if (deletedName) {
    merged.delete(deletedName);
  }

  const toSave = [...merged.values()];

  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    writeFileSync(CRON_JOBS_FILE, JSON.stringify(toSave, null, 2), "utf-8");
  } catch (err) {
    console.error("Cron: failed to save runtime jobs:", err);
  }
}

// --- Scheduling ---

function scheduleJob(state: CronJobState): void {
  if (!state.enabled || !state.schedule) return;

  const cron = new Cron(
    state.schedule,
    { timezone: state.timezone },
    async () => {
      await executeJob(state);
      state.nextRun = cron.nextRun() ?? null;
    },
  );

  state.instance = cron;
  state.nextRun = cron.nextRun() ?? null;
}

async function executeJob(state: CronJobState): Promise<{ success: boolean; output: string }> {
  const startTime = Date.now();
  state.lastRun = new Date();
  state.lastError = null;

  let output = "";
  let success = true;

  try {
    output = await resolveCronPayload(state);
    if (!output.trim()) {
      throw new Error("LLM returned empty response — nothing to send");
    }
    await sendToChannel(state.channelId, output);
    console.log(`Cron [${state.name}]: sent to ${state.channelId}`);
  } catch (err) {
    state.lastError = String(err);
    output = String(err);
    success = false;
    console.error(`Cron [${state.name}] error:`, err);
  }

  const record: CronExecutionRecord = {
    timestamp: new Date().toISOString(),
    success,
    durationMs: Date.now() - startTime,
    outputPreview: output.slice(0, OUTPUT_PREVIEW_LENGTH),
    error: success ? null : state.lastError,
  };

  state.history.push(record);
  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }

  savePersistedJobs();

  return { success, output: output.slice(0, OUTPUT_PREVIEW_LENGTH) };
}

async function resolveCronPayload(
  job: Pick<CronJobState, "type" | "name" | "prompt" | "message">,
): Promise<string> {
  if (job.type === "llm") {
    if (!job.prompt) throw new Error(`Cron [${job.name}]: type is "llm" but no prompt defined`);
    const wrappedPrompt =
      `[AUTOMATED CRON TASK — "${job.name}"]\n` +
      `Execute the following task directly. Do not ask questions, request clarification, or wait for input. ` +
      `Produce your final output immediately.\n\n` +
      job.prompt;
    return getLLMOneShot(wrappedPrompt);
  }
  if (!job.message) throw new Error(`Cron [${job.name}]: type is "static" but no message defined`);
  return job.message;
}

// --- Startup ---

export function startCron(): void {
  const persisted = loadPersistedJobs();

  for (const job of persisted) {
    const history = job.history ?? [];
    const lastEntry = history.length > 0 ? history[history.length - 1] : null;

    const state: CronJobState = {
      name: job.name,
      schedule: job.schedule,
      timezone: job.timezone,
      channelId: job.channelId,
      type: job.type,
      message: job.message,
      prompt: job.prompt,
      enabled: job.enabled,
      lastRun: lastEntry ? new Date(lastEntry.timestamp) : null,
      nextRun: null,
      lastError: lastEntry?.error ?? null,
      history,
      instance: null,
    };

    scheduleJob(state);
    cronJobs.push(state);

    if (state.enabled) {
      console.log(
        `Cron [${state.name}]: scheduled "${state.schedule}" -> ${state.channelId} (next: ${state.nextRun?.toISOString() ?? "none"})`,
      );
    }
  }

  const total = cronJobs.length;
  const enabled = cronJobs.filter((j) => j.enabled).length;
  if (total > 0) {
    console.log(`Cron: ${total} job(s) loaded, ${enabled} enabled`);
  }
}

export function stopCron(): void {
  for (const state of cronJobs) {
    state.instance?.stop();
  }
  cronJobs.length = 0;
}

// --- Runtime management ---

export function createCronJob(params: {
  name: string;
  schedule: string;
  timezone?: string;
  channelId: string;
  type: "static" | "llm";
  message?: string;
  prompt?: string;
  enabled?: boolean;
}): { success: boolean; error?: string } {
  if (cronJobs.some((j) => j.name === params.name)) {
    return { success: false, error: `Job "${params.name}" already exists` };
  }

  try {
    const test = new Cron(params.schedule);
    test.stop();
  } catch {
    return { success: false, error: `Invalid cron schedule: "${params.schedule}"` };
  }

  if (params.type === "llm" && !params.prompt) {
    return { success: false, error: 'Type "llm" requires a prompt' };
  }
  if (params.type === "static" && !params.message) {
    return { success: false, error: 'Type "static" requires a message' };
  }

  const state: CronJobState = {
    name: params.name,
    schedule: params.schedule,
    timezone: params.timezone,
    channelId: params.channelId,
    type: params.type,
    message: params.message,
    prompt: params.prompt,
    enabled: params.enabled ?? true,
    lastRun: null,
    nextRun: null,
    lastError: null,
    history: [],
    instance: null,
  };

  scheduleJob(state);
  cronJobs.push(state);
  savePersistedJobs();

  console.log(`Cron [${state.name}]: created runtime job "${state.schedule}" -> ${state.channelId}`);
  return { success: true };
}

export function toggleCronJob(name: string): { found: boolean; enabled: boolean } {
  const job = cronJobs.find((j) => j.name === name);
  if (!job) return { found: false, enabled: false };

  job.enabled = !job.enabled;

  if (job.enabled) {
    scheduleJob(job);
  } else {
    job.instance?.stop();
    job.instance = null;
    job.nextRun = null;
  }

  savePersistedJobs();

  console.log(`Cron [${job.name}]: ${job.enabled ? "enabled" : "disabled"}`);
  return { found: true, enabled: job.enabled };
}

export async function triggerCronJob(
  name: string,
): Promise<{ found: boolean; error?: string; output?: string }> {
  const job = cronJobs.find((j) => j.name === name);
  if (!job) return { found: false, error: "Job not found" };

  const result = await executeJob(job);

  if (result.success) {
    return { found: true, output: result.output };
  }
  return { found: true, error: job.lastError ?? "Unknown error" };
}

export function deleteCronJob(name: string): { found: boolean; error?: string } {
  const idx = cronJobs.findIndex((j) => j.name === name);
  if (idx === -1) return { found: false, error: "Job not found" };

  const job = cronJobs[idx];

  job.instance?.stop();
  cronJobs.splice(idx, 1);
  savePersistedJobs(name);

  console.log(`Cron [${name}]: deleted runtime job`);
  return { found: true };
}

export function updateCronJob(
  name: string,
  updates: {
    schedule?: string;
    timezone?: string;
    channelId?: string;
    type?: "static" | "llm";
    message?: string;
    prompt?: string;
    enabled?: boolean;
  },
): { found: boolean; error?: string } {
  const job = cronJobs.find((j) => j.name === name);
  if (!job) return { found: false, error: "Job not found" };

  // Validate new schedule if provided
  if (updates.schedule) {
    try {
      const test = new Cron(updates.schedule);
      test.stop();
    } catch {
      return { found: true, error: `Invalid schedule: "${updates.schedule}"` };
    }
  }

  // Apply updates
  if (updates.schedule !== undefined) job.schedule = updates.schedule;
  if (updates.timezone !== undefined) job.timezone = updates.timezone;
  if (updates.channelId !== undefined) job.channelId = updates.channelId;
  if (updates.type !== undefined) job.type = updates.type;
  if (updates.message !== undefined) job.message = updates.message;
  if (updates.prompt !== undefined) job.prompt = updates.prompt;
  if (updates.enabled !== undefined) job.enabled = updates.enabled;

  // Validate type/content consistency
  if (job.type === "llm" && !job.prompt) return { found: true, error: 'Type "llm" requires a prompt' };
  if (job.type === "static" && !job.message) return { found: true, error: 'Type "static" requires a message' };

  // Re-schedule
  job.instance?.stop();
  job.instance = null;
  job.nextRun = null;
  if (job.enabled) scheduleJob(job);

  savePersistedJobs();
  console.log(`Cron [${job.name}]: updated runtime job`);
  return { found: true };
}

// --- API serialization ---

export function getCronJobsForAPI() {
  return cronJobs.map((j) => ({
    name: j.name,
    schedule: j.schedule,
    timezone: j.timezone ?? null,
    channelId: j.channelId,
    type: j.type,
    message: j.message ?? null,
    prompt: j.prompt ?? null,
    enabled: j.enabled,
    lastRun: j.lastRun?.toISOString() ?? null,
    nextRun: j.nextRun?.toISOString() ?? null,
    lastError: j.lastError,
    history: j.history,
  }));
}

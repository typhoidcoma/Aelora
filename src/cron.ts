import { Cron } from "croner";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { Config, CronJobConfig } from "./config.js";
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
  source: "config" | "runtime";
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

function savePersistedJobs(): void {
  const runtimeJobs: PersistedCronJob[] = cronJobs
    .filter((j) => j.source === "runtime")
    .map((j) => ({
      name: j.name,
      schedule: j.schedule,
      timezone: j.timezone,
      channelId: j.channelId,
      type: j.type,
      message: j.message,
      prompt: j.prompt,
      enabled: j.enabled,
      history: j.history,
    }));

  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    writeFileSync(CRON_JOBS_FILE, JSON.stringify(runtimeJobs, null, 2), "utf-8");
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

  if (state.source === "runtime") savePersistedJobs();

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

export function startCron(config: Config): void {
  // 1. Config-based jobs
  for (const job of config.cron.jobs) {
    const state: CronJobState = {
      name: job.name,
      schedule: job.schedule,
      timezone: job.timezone,
      channelId: job.channelId,
      type: job.type,
      message: job.message,
      prompt: job.prompt,
      enabled: job.enabled,
      source: "config",
      lastRun: null,
      nextRun: null,
      lastError: null,
      history: [],
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

  // 2. Runtime-persisted jobs
  const persisted = loadPersistedJobs();
  const configNames = new Set(config.cron.jobs.map((j) => j.name));

  for (const job of persisted) {
    if (configNames.has(job.name)) {
      console.warn(`Cron: runtime job "${job.name}" skipped (name conflict with config job)`);
      continue;
    }

    const state: CronJobState = {
      name: job.name,
      schedule: job.schedule,
      timezone: job.timezone,
      channelId: job.channelId,
      type: job.type,
      message: job.message,
      prompt: job.prompt,
      enabled: job.enabled,
      source: "runtime",
      lastRun: null,
      nextRun: null,
      lastError: null,
      history: job.history ?? [],
      instance: null,
    };

    scheduleJob(state);
    cronJobs.push(state);

    if (state.enabled) {
      console.log(
        `Cron [${state.name}]: restored runtime job "${state.schedule}" -> ${state.channelId}`,
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
    source: "runtime",
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

  if (job.source === "runtime") savePersistedJobs();

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

  if (job.source === "config") {
    return { found: true, error: "Cannot delete config-based jobs. Disable them in settings.yaml." };
  }

  job.instance?.stop();
  cronJobs.splice(idx, 1);
  savePersistedJobs();

  console.log(`Cron [${name}]: deleted runtime job`);
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
    source: j.source,
    lastRun: j.lastRun?.toISOString() ?? null,
    nextRun: j.nextRun?.toISOString() ?? null,
    lastError: j.lastError,
    history: j.history,
  }));
}

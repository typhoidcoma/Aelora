import { Cron } from "croner";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
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

export type PersistedCronJob = {
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

export type CronJobInfo = {
  name: string;
  schedule: string;
  timezone: string | null;
  channelId: string;
  type: "static" | "llm";
  message: string | null;
  prompt: string | null;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  lastError: string | null;
  history: CronExecutionRecord[];
};

// --- Constants ---

const CRON_JOBS_FILE = "data/cron-jobs.json";
const CRON_JOBS_TMP = "data/cron-jobs.tmp.json";
let maxHistory = 10;
const OUTPUT_PREVIEW_LENGTH = 300;

/** Apply config overrides. Call after config is loaded. */
export function configureCron(opts: { maxHistory?: number }): void {
  if (opts.maxHistory) maxHistory = opts.maxHistory;
}

// --- State ---
// The ONLY module-level mutable state. Not exported.
// Maps job name -> live Cron instance + schedule metadata for change detection.

type SchedulerEntry = {
  cron: Cron;
  schedule: string;
  timezone: string | undefined;
};

const schedulers = new Map<string, SchedulerEntry>();

// --- File I/O ---

function loadJobs(): PersistedCronJob[] {
  try {
    if (existsSync(CRON_JOBS_FILE)) {
      return JSON.parse(readFileSync(CRON_JOBS_FILE, "utf-8"));
    }
  } catch {
    console.warn("Cron: failed to read jobs file, starting fresh");
  }
  return [];
}

function saveJobs(jobs: PersistedCronJob[]): void {
  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    writeFileSync(CRON_JOBS_TMP, JSON.stringify(jobs, null, 2), "utf-8");
    renameSync(CRON_JOBS_TMP, CRON_JOBS_FILE);
  } catch (err) {
    console.error("Cron: failed to save jobs:", err);
  }
}

// --- Scheduler management ---

function createScheduler(job: PersistedCronJob): void {
  const jobName = job.name; // capture name, not the object

  const cron = new Cron(
    job.schedule,
    { timezone: job.timezone },
    async () => {
      await executeJob(jobName);
    },
  );

  schedulers.set(job.name, {
    cron,
    schedule: job.schedule,
    timezone: job.timezone,
  });
}

function stopScheduler(name: string): void {
  const entry = schedulers.get(name);
  if (entry) {
    entry.cron.stop();
    schedulers.delete(name);
  }
}

function syncSchedulers(jobs: PersistedCronJob[]): void {
  const jobNames = new Set(jobs.map((j) => j.name));

  // Stop schedulers for removed jobs
  for (const name of schedulers.keys()) {
    if (!jobNames.has(name)) {
      stopScheduler(name);
    }
  }

  // Start/restart/stop schedulers based on job state
  for (const job of jobs) {
    const existing = schedulers.get(job.name);

    if (!job.enabled) {
      if (existing) stopScheduler(job.name);
      continue;
    }

    // Enabled job — check if scheduler needs creating or updating
    if (existing && existing.schedule === job.schedule && existing.timezone === job.timezone) {
      continue; // no change, leave running
    }

    // Stop old scheduler if schedule/timezone changed
    if (existing) stopScheduler(job.name);

    // Create new scheduler
    try {
      createScheduler(job);
    } catch (err) {
      console.error(`Cron [${job.name}]: failed to schedule "${job.schedule}":`, err);
    }
  }
}

// --- Job execution ---

async function executeJob(name: string): Promise<{ success: boolean; output: string }> {
  // Load latest job data from file
  const jobs = loadJobs();
  const job = jobs.find((j) => j.name === name);

  if (!job) {
    console.warn(`Cron [${name}]: job not found in file, skipping execution`);
    return { success: false, output: "Job not found" };
  }

  const startTime = Date.now();
  let output = "";
  let success = true;
  let error: string | null = null;

  console.log(`Cron [${name}]: executing (type=${job.type})`);

  try {
    output = await resolveCronPayload(job);
    if (!output.trim()) {
      throw new Error("LLM returned empty response — nothing to send");
    }
    await sendToChannel(job.channelId, output);
  } catch (err) {
    error = String(err);
    output = String(err);
    success = false;
    console.error(`Cron [${name}] error:`, err);
  }

  const durationMs = Date.now() - startTime;
  console.log(`Cron [${name}]: ${success ? "completed" : "failed"} in ${durationMs}ms`);

  const record: CronExecutionRecord = {
    timestamp: new Date().toISOString(),
    success,
    durationMs,
    outputPreview: output.slice(0, OUTPUT_PREVIEW_LENGTH),
    error,
  };

  // Re-load file before saving history (another write may have happened during async execution)
  const freshJobs = loadJobs();
  const freshJob = freshJobs.find((j) => j.name === name);

  if (freshJob) {
    freshJob.history.push(record);
    if (freshJob.history.length > maxHistory) {
      freshJob.history = freshJob.history.slice(-maxHistory);
    }
    saveJobs(freshJobs);
  }

  return { success, output: output.slice(0, OUTPUT_PREVIEW_LENGTH) };
}

async function resolveCronPayload(
  job: Pick<PersistedCronJob, "type" | "name" | "prompt" | "message">,
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

// --- Startup / Shutdown ---

export function startCron(): void {
  const jobs = loadJobs();
  syncSchedulers(jobs);

  const total = jobs.length;
  const enabled = jobs.filter((j) => j.enabled).length;

  if (total > 0) {
    for (const job of jobs) {
      if (job.enabled) {
        const entry = schedulers.get(job.name);
        const nextRun = entry?.cron.nextRun()?.toISOString() ?? "none";
        console.log(
          `Cron [${job.name}]: scheduled "${job.schedule}" -> ${job.channelId} (next: ${nextRun})`,
        );
      }
    }
    console.log(`Cron: ${total} job(s) loaded, ${enabled} enabled`);
  }
}

export function stopCron(): void {
  for (const [, entry] of schedulers) {
    entry.cron.stop();
  }
  schedulers.clear();
}

// --- Public API ---

export function getCronJobs(): CronJobInfo[] {
  const jobs = loadJobs();
  return jobs.map((j) => {
    const lastEntry = j.history.length > 0 ? j.history[j.history.length - 1] : null;
    const entry = schedulers.get(j.name);

    return {
      name: j.name,
      schedule: j.schedule,
      timezone: j.timezone ?? null,
      channelId: j.channelId,
      type: j.type,
      message: j.message ?? null,
      prompt: j.prompt ?? null,
      enabled: j.enabled,
      lastRun: lastEntry?.timestamp ?? null,
      nextRun: entry?.cron.nextRun()?.toISOString() ?? null,
      lastError: lastEntry?.error ?? null,
      history: j.history,
    };
  });
}

export function getCronJobsForAPI(): CronJobInfo[] {
  return getCronJobs();
}

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
  const jobs = loadJobs();

  if (jobs.some((j) => j.name === params.name)) {
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

  const newJob: PersistedCronJob = {
    name: params.name,
    schedule: params.schedule,
    timezone: params.timezone,
    channelId: params.channelId,
    type: params.type,
    message: params.message,
    prompt: params.prompt,
    enabled: params.enabled ?? true,
    history: [],
  };

  jobs.push(newJob);
  saveJobs(jobs);
  syncSchedulers(jobs);

  console.log(`Cron [${newJob.name}]: created "${newJob.schedule}" -> ${newJob.channelId}`);
  return { success: true };
}

export function deleteCronJob(name: string): { found: boolean; error?: string } {
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.name === name);

  if (idx === -1) return { found: false, error: "Job not found" };

  jobs.splice(idx, 1);
  saveJobs(jobs);
  stopScheduler(name);

  console.log(`Cron [${name}]: deleted`);
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
  const jobs = loadJobs();
  const job = jobs.find((j) => j.name === name);

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

  saveJobs(jobs);
  syncSchedulers(jobs);

  console.log(`Cron [${job.name}]: updated`);
  return { found: true };
}

export function toggleCronJob(name: string): { found: boolean; enabled: boolean } {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.name === name);

  if (!job) return { found: false, enabled: false };

  job.enabled = !job.enabled;
  saveJobs(jobs);
  syncSchedulers(jobs);

  console.log(`Cron [${job.name}]: ${job.enabled ? "enabled" : "disabled"}`);
  return { found: true, enabled: job.enabled };
}

export async function triggerCronJob(
  name: string,
): Promise<{ found: boolean; error?: string; output?: string }> {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.name === name);

  if (!job) return { found: false, error: "Job not found" };

  const result = await executeJob(name);

  if (result.success) {
    return { found: true, output: result.output };
  }
  return { found: true, error: result.output };
}

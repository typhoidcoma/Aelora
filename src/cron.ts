import { Cron } from "croner";
import type { Config, CronJobConfig } from "./config.js";
import { getLLMOneShot } from "./llm.js";
import { sendToChannel } from "./discord.js";

export type CronJobState = {
  name: string;
  schedule: string;
  channelId: string;
  type: "static" | "llm";
  enabled: boolean;
  lastRun: Date | null;
  nextRun: Date | null;
  lastError: string | null;
  instance: Cron | null;
};

// Exposed for the web dashboard
export const cronJobs: CronJobState[] = [];

export function startCron(config: Config): void {
  for (const job of config.cron.jobs) {
    const state: CronJobState = {
      name: job.name,
      schedule: job.schedule,
      channelId: job.channelId,
      type: job.type,
      enabled: job.enabled,
      lastRun: null,
      nextRun: null,
      lastError: null,
      instance: null,
    };

    if (!job.enabled) {
      cronJobs.push(state);
      continue;
    }

    if (!job.schedule) {
      console.warn(`Cron [${job.name}]: missing schedule, skipping`);
      cronJobs.push(state);
      continue;
    }

    const cron = new Cron(
      job.schedule,
      { timezone: job.timezone },
      async () => {
        state.lastRun = new Date();
        state.lastError = null;

        try {
          const text = await resolveCronPayload(job);
          await sendToChannel(job.channelId, text);
          console.log(`Cron [${job.name}]: sent to ${job.channelId}`);
        } catch (err) {
          state.lastError = String(err);
          console.error(`Cron [${job.name}] error:`, err);
        }

        state.nextRun = cron.nextRun() ?? null;
      },
    );

    state.instance = cron;
    state.nextRun = cron.nextRun() ?? null;
    cronJobs.push(state);

    console.log(
      `Cron [${job.name}]: scheduled "${job.schedule}" -> ${job.channelId} (next: ${state.nextRun?.toISOString() ?? "none"})`,
    );
  }
}

async function resolveCronPayload(job: CronJobConfig): Promise<string> {
  if (job.type === "llm") {
    if (!job.prompt) throw new Error(`Cron [${job.name}]: type is "llm" but no prompt defined`);
    return getLLMOneShot(job.prompt);
  }
  // static
  if (!job.message) throw new Error(`Cron [${job.name}]: type is "static" but no message defined`);
  return job.message;
}

export function stopCron(): void {
  for (const state of cronJobs) {
    state.instance?.stop();
  }
  cronJobs.length = 0;
}

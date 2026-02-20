import { defineTool, param } from "./types.js";
import {
  getCronJobsForAPI,
  createCronJob,
  toggleCronJob,
  triggerCronJob,
  deleteCronJob,
} from "../cron.js";

export default defineTool({
  name: "cron",
  description:
    "Manage scheduled cron jobs. List all jobs, create new scheduled tasks, " +
    "toggle jobs on/off, manually trigger a job, or delete runtime jobs. " +
    "Jobs can send static messages or LLM-generated content to a Discord channel on a schedule.",

  params: {
    action: param.enum(
      "The cron action to perform.",
      ["list", "create", "toggle", "trigger", "delete"] as const,
      { required: true },
    ),
    name: param.string(
      "Job name. Required for create, toggle, trigger, and delete.",
      { maxLength: 100 },
    ),
    schedule: param.string(
      "Cron schedule expression (e.g. '0 9 * * *' for daily at 9am, '*/30 * * * *' for every 30 min). Required for create.",
      { maxLength: 100 },
    ),
    timezone: param.string(
      "IANA timezone for the schedule (e.g. 'America/New_York', 'Europe/London'). Optional for create.",
    ),
    channelId: param.string(
      "Discord channel ID to send messages to. Defaults to the current channel. Optional for create.",
    ),
    type: param.enum(
      "Job type: 'static' sends a fixed message, 'llm' generates a response from a prompt. Required for create.",
      ["static", "llm"] as const,
    ),
    message: param.string(
      "The static message to send. Required when type is 'static'.",
    ),
    prompt: param.string(
      "The LLM prompt to generate a message from. Required when type is 'llm'.",
    ),
    enabled: param.boolean(
      "Whether the job starts enabled. Defaults to true. Optional for create.",
    ),
  },

  handler: async (
    { action, name, schedule, timezone, channelId, type, message, prompt, enabled },
    context,
  ) => {
    switch (action) {
      case "list": {
        const jobs = getCronJobsForAPI();
        if (jobs.length === 0) return "No cron jobs configured.";

        const lines = jobs.map((j) => {
          const status = j.enabled ? "enabled" : "disabled";
          const next = j.nextRun ? `next: ${j.nextRun}` : "not scheduled";
          const last = j.lastRun ? `last: ${j.lastRun}` : "never run";
          return (
            `**${j.name}** (${status})\n` +
            `  Schedule: \`${j.schedule}\` | Type: ${j.type} | Source: ${j.source}\n` +
            `  Channel: ${j.channelId} | ${next} | ${last}` +
            (j.lastError ? `\n  Last error: ${j.lastError}` : "")
          );
        });

        return `**Cron Jobs** (${jobs.length}):\n\n${lines.join("\n\n")}`;
      }

      case "create": {
        if (!name) return "Error: name is required for create.";
        if (!schedule) return "Error: schedule is required for create.";
        if (!type) return "Error: type is required for create (\"static\" or \"llm\").";

        const targetChannel = channelId ?? context.channelId;
        if (!targetChannel) return "Error: channelId is required (no current channel available).";

        const result = createCronJob({
          name,
          schedule,
          timezone,
          channelId: targetChannel,
          type,
          message,
          prompt,
          enabled,
        });

        if (!result.success) return `Error: ${result.error}`;
        return `Cron job "${name}" created. Schedule: \`${schedule}\` | Type: ${type} | Channel: ${targetChannel}`;
      }

      case "toggle": {
        if (!name) return "Error: name is required for toggle.";

        const result = toggleCronJob(name);
        if (!result.found) return `Error: job "${name}" not found.`;
        return `Cron job "${name}" is now ${result.enabled ? "enabled" : "disabled"}.`;
      }

      case "trigger": {
        if (!name) return "Error: name is required for trigger.";

        const result = await triggerCronJob(name);
        if (!result.found) return `Error: job "${name}" not found.`;
        if (result.error) return `Job "${name}" triggered but failed: ${result.error}`;
        return `Job "${name}" triggered successfully.\nOutput: ${result.output ?? "(no output)"}`;
      }

      case "delete": {
        if (!name) return "Error: name is required for delete.";

        const result = deleteCronJob(name);
        if (!result.found) return `Error: job "${name}" not found.`;
        if (result.error) return `Error: ${result.error}`;
        return `Cron job "${name}" deleted.`;
      }

      default:
        return `Unknown action "${action}". Use list, create, toggle, trigger, or delete.`;
    }
  },
});

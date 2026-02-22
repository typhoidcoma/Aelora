import { defineTool, param } from "./types.js";
import {
  getCronJobsForAPI,
  createCronJob,
  updateCronJob,
  toggleCronJob,
  triggerCronJob,
  deleteCronJob,
} from "../cron.js";

export default defineTool({
  name: "cron",
  description:
    "Manage scheduled cron jobs. List all jobs, create or edit scheduled tasks, " +
    "toggle jobs on/off, manually trigger a job, or delete runtime jobs. " +
    "Jobs can send static messages or LLM-generated content to a Discord channel on a schedule.",

  params: {
    action: param.enum(
      "The cron action to perform.",
      ["list", "view", "create", "edit", "toggle", "trigger", "delete"] as const,
      { required: true },
    ),
    name: param.string(
      "Job name. Required for create, edit, toggle, trigger, and delete.",
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
            `  Schedule: \`${j.schedule}\` | Type: ${j.type}\n` +
            `  Channel: ${j.channelId} | ${next} | ${last}` +
            (j.lastError ? `\n  Last error: ${j.lastError}` : "")
          );
        });

        return `**Cron Jobs** (${jobs.length}):\n\n${lines.join("\n\n")}`;
      }

      case "view": {
        if (!name) return "Error: name is required for view.";

        const jobs = getCronJobsForAPI();
        const job = jobs.find((j) => j.name === name);
        if (!job) return `Error: job "${name}" not found.`;

        const status = job.enabled ? "enabled" : "disabled";
        const next = job.nextRun ? job.nextRun : "not scheduled";
        const last = job.lastRun ? job.lastRun : "never run";

        let detail =
          `**${job.name}** (${status})\n` +
          `Schedule: \`${job.schedule}\`${job.timezone ? ` (${job.timezone})` : ""}\n` +
          `Type: ${job.type} | Channel: ${job.channelId}\n` +
          `Next: ${next} | Last: ${last}`;

        if (job.type === "llm" && job.prompt) {
          detail += `\n\n**Prompt:**\n${job.prompt}`;
        } else if (job.type === "static" && job.message) {
          detail += `\n\n**Message:**\n${job.message}`;
        }

        if (job.lastError) {
          detail += `\n\n**Last error:** ${job.lastError}`;
        }

        if (job.history.length > 0) {
          const historyLines = job.history.map((h) => {
            const icon = h.success ? "+" : "-";
            const dur = `${h.durationMs}ms`;
            return `${icon} ${h.timestamp} (${dur})${h.error ? ` — ${h.error}` : ""}\n  ${h.outputPreview}`;
          });
          detail += `\n\n**History** (last ${job.history.length}):\n${historyLines.join("\n")}`;
        } else {
          detail += `\n\n**History:** none`;
        }

        return detail;
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

      case "edit": {
        if (!name) return "Error: name is required for edit.";

        const updates: Record<string, unknown> = {};
        if (schedule !== undefined) updates.schedule = schedule;
        if (timezone !== undefined) updates.timezone = timezone;
        if (channelId !== undefined) updates.channelId = channelId;
        if (type !== undefined) updates.type = type;
        if (message !== undefined) updates.message = message;
        if (prompt !== undefined) updates.prompt = prompt;
        if (enabled !== undefined) updates.enabled = enabled;

        const result = updateCronJob(name, updates);
        if (!result.found) return `Error: job "${name}" not found.`;
        if (result.error) return `Error: ${result.error}`;
        return `Cron job "${name}" updated successfully.`;
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
        return `Unknown action "${action}". Use list, view, create, edit, toggle, trigger, or delete.`;
    }
  },
});

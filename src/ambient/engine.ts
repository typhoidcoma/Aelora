import { registerHeartbeatHandler, type HeartbeatHandler } from "../heartbeat.js";
import { getAllBuffers, recordAmbientSend, getBufferStats } from "./buffer.js";
import type { AmbientTrigger, TriggerContext, TriggerResult } from "./types.js";
import type { Config } from "../config.js";
import { broadcastEvent } from "../logger.js";
import { appendLog } from "../daily-log.js";
import { classifyMood } from "../mood.js";
import { chunkMessage } from "../utils.js";
import { getLLMClient, getAuxiliaryModel, stripThinkBlocks } from "../llm.js";

// All triggers (imported statically for reliability)
import { lurkerTrigger } from "./triggers/lurker.js";
import { patternCalloutTrigger } from "./triggers/pattern-callout.js";
import { vibeShiftTrigger } from "./triggers/vibe-shift.js";
import { suspiciouslyQuietTrigger } from "./triggers/suspiciously-quiet.js";
import { celebrationTrigger } from "./triggers/celebration.js";
import { cursedImageTrigger } from "./triggers/cursed-image.js";
import { callbackTrigger } from "./triggers/callback.js";
import { topicDriftTrigger } from "./triggers/topic-drift.js";
import { deadChannelTrigger } from "./triggers/dead-channel.js";

type TriggerConfigKey = keyof Config["ambient"]["triggers"];

// Map trigger names to config keys
const TRIGGER_CONFIG_MAP: Record<string, TriggerConfigKey> = {
  lurker: "lurker",
  "pattern-callout": "patternCallout",
  "vibe-shift": "vibeShift",
  "suspiciously-quiet": "suspiciouslyQuiet",
  celebration: "celebration",
  "cursed-image": "cursedImage",
  callback: "callback",
  "topic-drift": "topicDrift",
  "dead-channel": "deadChannel",
};

const allTriggers: AmbientTrigger[] = [
  lurkerTrigger,
  patternCalloutTrigger,
  vibeShiftTrigger,
  suspiciouslyQuietTrigger,
  celebrationTrigger,
  cursedImageTrigger,
  callbackTrigger,
  topicDriftTrigger,
  deadChannelTrigger,
];

// State
const triggerCooldowns = new Map<string, number>(); // "triggerName:channelId" -> timestamp
const globalSendTimestamps: number[] = [];
let evaluationTimer: ReturnType<typeof setInterval> | null = null;
let savedConfig: Config | null = null;
let savedSendToChannel: ((channelId: string, text: string) => Promise<void>) | null = null;

// Runtime overrides for trigger enabled state (from API toggle)
const runtimeOverrides = new Map<string, boolean>();

function cooldownKey(triggerName: string, channelId: string): string {
  return `${triggerName}:${channelId}`;
}

function canSendGlobally(config: Config): boolean {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  // prune old timestamps
  while (globalSendTimestamps.length > 0 && globalSendTimestamps[0] < oneHourAgo) {
    globalSendTimestamps.shift();
  }
  return globalSendTimestamps.length < config.ambient.globalRateLimitPerHour;
}

function canSendToChannel(channelId: string, config: Config): boolean {
  const buf = getAllBuffers().find((b) => b.channelId === channelId);
  if (!buf) return false;
  const cooldownMs = config.ambient.channelCooldownMinutes * 60 * 1000;
  return Date.now() - buf.lastAmbientSendAt >= cooldownMs;
}

function canFireTrigger(triggerName: string, channelId: string, cooldownMinutes: number): boolean {
  const key = cooldownKey(triggerName, channelId);
  const last = triggerCooldowns.get(key) ?? 0;
  return Date.now() - last >= cooldownMinutes * 60 * 1000;
}

function isTriggerEnabled(trigger: AmbientTrigger, config: Config): boolean {
  // check runtime override first
  const override = runtimeOverrides.get(trigger.name);
  if (override !== undefined) return override;

  const configKey = TRIGGER_CONFIG_MAP[trigger.name];
  if (!configKey) return true;
  return config.ambient.triggers[configKey].enabled;
}

function getTriggerConfig(trigger: AmbientTrigger, config: Config) {
  const configKey = TRIGGER_CONFIG_MAP[trigger.name];
  if (!configKey) return { enabled: true, cooldownMinutes: 30, skipChance: 0.25 };
  return config.ambient.triggers[configKey];
}

/** Lightweight LLM call using auxiliary model, no tools/persona bloat. */
async function llmEvaluate(prompt: string, config: Config): Promise<string> {
  const client = getLLMClient();
  const model = getAuxiliaryModel();

  // Use persona's composed prompt as a slim identity context
  const personaContext = config.llm.systemPrompt.slice(0, 2000); // just enough for voice/tone

  const result = await client.chat.completions.create({
    model,
    max_completion_tokens: 512,
    messages: [
      {
        role: "system",
        content: `${personaContext}\n\n[AMBIENT MODE] You are passively observing Discord channels. Keep responses short (1-4 sentences max). All lowercase. If nothing is worth commenting on, respond with exactly SKIP.`,
      },
      { role: "user", content: prompt },
    ],
  });

  const raw = result.choices[0]?.message?.content?.trim() ?? "";
  return stripThinkBlocks(raw);
}

/** Shuffle array in place (Fisher-Yates). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function evaluateTick(): Promise<string | void> {
  const config = savedConfig;
  const sendToChannel = savedSendToChannel;
  if (!config || !sendToChannel) return;
  if (!config.ambient.enabled) return;

  const { discordClient, botUserId } = await import("../discord.js");
  if (!discordClient || !botUserId) return;

  if (!canSendGlobally(config)) return;

  const buffers = getAllBuffers().filter(
    (buf) => buf.messages.length >= config.ambient.minBufferMessages,
  );

  if (buffers.length === 0) return;

  const results: string[] = [];

  for (const buffer of buffers) {
    if (!canSendGlobally(config)) break;
    if (!canSendToChannel(buffer.channelId, config)) continue;

    // shuffle triggers so no priority bias
    const shuffled = shuffle([...allTriggers]);

    for (const trigger of shuffled) {
      if (!isTriggerEnabled(trigger, config)) continue;

      const triggerConf = getTriggerConfig(trigger, config);
      if (!canFireTrigger(trigger.name, buffer.channelId, triggerConf.cooldownMinutes)) continue;

      // cheap pre-filter
      if (!trigger.shouldEvaluate(buffer, config)) continue;

      // random skip
      if (Math.random() < triggerConf.skipChance) continue;

      // full evaluation
      let result: TriggerResult;
      try {
        const ctx: TriggerContext = {
          buffer,
          config,
          botUserId,
          llmEvaluate: (prompt) => llmEvaluate(prompt, config),
          getAllBuffers,
        };
        result = await trigger.evaluate(ctx);
      } catch (err) {
        console.error(`Ambient: trigger "${trigger.name}" error:`, err);
        continue;
      }

      broadcastEvent("mindmap", {
        type: "ambient:evaluated",
        conversationId: buffer.channelId,
        trigger: trigger.name,
        fired: result.message !== null,
        reason: result.debugReason ?? null,
        timestamp: new Date().toISOString(),
      });

      if (!result.message || result.message.trim().toUpperCase() === "SKIP" || result.message.trim().length === 0) {
        continue;
      }

      // clean up wrapping quotes
      let cleaned = result.message.trim();
      if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        cleaned = cleaned.slice(1, -1);
      }

      // optional delay for natural feel
      const delay = result.delayMs ?? (2000 + Math.random() * 6000);
      await new Promise((r) => setTimeout(r, delay));

      // send the message
      try {
        if (result.replyToMessageId) {
          const channel = await discordClient.channels.fetch(buffer.channelId);
          if (channel && channel.isTextBased() && "messages" in channel) {
            const targetMsg = await (channel as import("discord.js").TextChannel).messages.fetch(result.replyToMessageId);
            const chunks = chunkMessage(cleaned);
            await targetMsg.reply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
              await (channel as import("discord.js").TextChannel).send(chunks[i]);
            }
          }
        } else {
          await sendToChannel(buffer.channelId, cleaned);
        }
      } catch (err) {
        console.error(`Ambient: failed to send to #${buffer.channelName}:`, err);
        continue;
      }

      // record cooldowns and timestamps
      triggerCooldowns.set(cooldownKey(trigger.name, buffer.channelId), Date.now());
      globalSendTimestamps.push(Date.now());
      recordAmbientSend(buffer.channelId);

      broadcastEvent("mindmap", {
        type: "ambient:sent",
        conversationId: buffer.channelId,
        trigger: trigger.name,
        preview: cleaned.slice(0, 80),
        timestamp: new Date().toISOString(),
      });

      appendLog({
        channelName: buffer.channelName,
        userId: botUserId,
        username: `ambient/${trigger.name}`,
        summary: `**[${trigger.name}]** ${cleaned.slice(0, 200)}`,
      });

      classifyMood(cleaned, buffer.messages.slice(-3).map((m) => m.content).join("\n"), buffer.channelId).catch(() => {});

      results.push(`${trigger.name} in #${buffer.channelName}`);

      // one message per channel per tick
      break;
    }
  }

  if (results.length > 0) {
    return `ambient: ${results.join(", ")}`;
  }
}

// --- Heartbeat handler ---

const ambientHandler: HeartbeatHandler = {
  name: "ambient",
  description: "Ambient awareness engine, evaluates channel triggers for proactive messages",
  enabled: true,

  execute: async (): Promise<string | void> => {
    // The heartbeat fires every 15 min, but the ambient engine has its own timer.
    // This handler just reports status.
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    while (globalSendTimestamps.length > 0 && globalSendTimestamps[0] < oneHourAgo) {
      globalSendTimestamps.shift();
    }
    const bufCount = getAllBuffers().length;
    if (bufCount > 0) {
      return `tracking ${bufCount} channel(s), ${globalSendTimestamps.length} sends last hour`;
    }
  },
};

export function registerAmbientEngine(
  config: Config,
  sendToChannel: (channelId: string, text: string) => Promise<void>,
): void {
  savedConfig = config;
  savedSendToChannel = sendToChannel;

  registerHeartbeatHandler(ambientHandler);

  // start the evaluation timer (independent of heartbeat interval)
  if (evaluationTimer) clearInterval(evaluationTimer);
  evaluationTimer = setInterval(() => {
    evaluateTick().catch((err) => console.error("Ambient: evaluation tick error:", err));
  }, config.ambient.evaluationIntervalMs);

  // also run once after a short startup delay
  setTimeout(() => {
    evaluateTick().catch((err) => console.error("Ambient: initial tick error:", err));
  }, 30_000);

  console.log(
    `Ambient: engine started (${config.ambient.evaluationIntervalMs / 1000}s interval, ` +
    `${allTriggers.filter((t) => isTriggerEnabled(t, config)).length}/${allTriggers.length} triggers enabled)`,
  );
}

export function stopAmbientEngine(): void {
  if (evaluationTimer) {
    clearInterval(evaluationTimer);
    evaluationTimer = null;
    console.log("Ambient: engine stopped");
  }
}

/** Toggle a trigger at runtime (persists until restart). */
export function toggleTrigger(name: string, enabled: boolean): boolean {
  const trigger = allTriggers.find((t) => t.name === name);
  if (!trigger) return false;
  runtimeOverrides.set(name, enabled);
  return true;
}

/** Dashboard state. */
export function getAmbientState(): {
  enabled: boolean;
  evaluationIntervalMs: number;
  globalSendsLastHour: number;
  globalRateLimitPerHour: number;
  triggers: Array<{ name: string; description: string; enabled: boolean; configKey: string }>;
  bufferStats: ReturnType<typeof getBufferStats>;
} {
  const config = savedConfig;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  while (globalSendTimestamps.length > 0 && globalSendTimestamps[0] < oneHourAgo) {
    globalSendTimestamps.shift();
  }

  return {
    enabled: config?.ambient.enabled ?? false,
    evaluationIntervalMs: config?.ambient.evaluationIntervalMs ?? 300_000,
    globalSendsLastHour: globalSendTimestamps.length,
    globalRateLimitPerHour: config?.ambient.globalRateLimitPerHour ?? 6,
    triggers: allTriggers.map((t) => ({
      name: t.name,
      description: t.description,
      enabled: config ? isTriggerEnabled(t, config) : false,
      configKey: TRIGGER_CONFIG_MAP[t.name] ?? t.name,
    })),
    bufferStats: getBufferStats(),
  };
}

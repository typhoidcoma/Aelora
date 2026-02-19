import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type CronJobConfig = {
  name: string;
  schedule: string;
  timezone?: string;
  channelId: string;
  type: "static" | "llm";
  message?: string;
  prompt?: string;
  enabled: boolean;
};

export type Config = {
  discord: {
    token: string;
    guildMode: "mention" | "all";
    allowedChannels: string[];
    allowDMs: boolean;
    status: string;
  };
  llm: {
    baseURL: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    maxTokens: number;
    maxHistory: number;
  };
  cron: {
    jobs: CronJobConfig[];
  };
  web: {
    enabled: boolean;
    port: number;
  };
  soul: {
    enabled: boolean;
    dir: string;
    botName: string;
  };
  heartbeat: {
    enabled: boolean;
    intervalMs: number;
  };
  agents: {
    enabled: boolean;
    maxIterations: number;
  };
};

export function loadConfig(path = "settings.yaml"): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(
      `Cannot read ${path}. Copy settings.example.yaml to settings.yaml and fill in your values.`,
    );
  }

  const parsed = parse(raw);

  if (!parsed?.discord?.token) {
    throw new Error("settings.yaml: discord.token is required");
  }
  if (!parsed?.llm?.baseURL) {
    throw new Error("settings.yaml: llm.baseURL is required");
  }
  if (!parsed?.llm?.model) {
    throw new Error("settings.yaml: llm.model is required");
  }

  return {
    discord: {
      token: parsed.discord.token,
      guildMode: parsed.discord.guildMode ?? "mention",
      allowedChannels: (parsed.discord.allowedChannels ?? []).map(String),
      allowDMs: parsed.discord.allowDMs ?? true,
      status: parsed.discord.status ?? "Online",
    },
    llm: {
      baseURL: parsed.llm.baseURL,
      apiKey: parsed.llm.apiKey ?? "",
      model: parsed.llm.model,
      systemPrompt: parsed.llm.systemPrompt ?? "You are a helpful assistant.",
      maxTokens: parsed.llm.maxTokens ?? 1024,
      maxHistory: parsed.llm.maxHistory ?? 20,
    },
    cron: {
      jobs: (parsed.cron?.jobs ?? []).map((j: Record<string, unknown>) => ({
        name: (j.name as string) ?? "Unnamed",
        schedule: j.schedule as string,
        timezone: j.timezone as string | undefined,
        channelId: String(j.channelId),
        type: (j.type as string) ?? "static",
        message: j.message as string | undefined,
        prompt: j.prompt as string | undefined,
        enabled: (j.enabled as boolean) ?? true,
      })),
    },
    web: {
      enabled: parsed.web?.enabled ?? true,
      port: parsed.web?.port ?? 3000,
    },
    soul: {
      enabled: parsed.soul?.enabled ?? true,
      dir: parsed.soul?.dir ?? "soul",
      botName: parsed.soul?.botName ?? "Aelora",
    },
    heartbeat: {
      enabled: parsed.heartbeat?.enabled ?? true,
      intervalMs: parsed.heartbeat?.intervalMs ?? 60_000,
    },
    agents: {
      enabled: parsed.agents?.enabled ?? true,
      maxIterations: parsed.agents?.maxIterations ?? 5,
    },
  };
}

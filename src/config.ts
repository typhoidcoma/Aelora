import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Config = {
  timezone: string;
  discord: {
    token: string;
    guildMode: "mention" | "all";
    allowedChannels: string[];
    allowDMs: boolean;
    status: string;
    guildId?: string;
    embedColor?: number;
    statusChannelId?: string;
  };
  llm: {
    baseURL: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    maxTokens: number;
    maxHistory: number;
  };
  web: {
    enabled: boolean;
    port: number;
    apiKey?: string;
  };
  persona: {
    enabled: boolean;
    dir: string;
    botName: string;
    activePersona: string;
  };
  heartbeat: {
    enabled: boolean;
    intervalMs: number;
  };
  agents: {
    enabled: boolean;
    maxIterations: number;
  };
  tools: Record<string, Record<string, unknown>>;
  activity: {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    serverUrl: string;
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
  console.log("Config: loaded settings.yaml");

  const config: Config = {
    timezone: parsed?.timezone ?? "UTC",
    discord: {
      token: parsed?.discord?.token ?? "",
      guildMode: parsed?.discord?.guildMode ?? "mention",
      allowedChannels: (parsed?.discord?.allowedChannels ?? []).map(String),
      allowDMs: parsed?.discord?.allowDMs ?? true,
      status: parsed?.discord?.status ?? "Online",
      guildId: parsed?.discord?.guildId ?? undefined,
      embedColor: parsed?.discord?.embedColor
        ? parseInt(String(parsed.discord.embedColor).replace("#", ""), 16)
        : undefined,
      statusChannelId: parsed?.discord?.statusChannelId ?? undefined,
    },
    llm: {
      baseURL: parsed?.llm?.baseURL ?? "",
      apiKey: parsed?.llm?.apiKey ?? "",
      model: parsed?.llm?.model ?? "",
      systemPrompt: parsed?.llm?.systemPrompt ?? "You are a helpful assistant.",
      maxTokens: parsed?.llm?.maxTokens ?? 1024,
      maxHistory: parsed?.llm?.maxHistory ?? 20,
    },
    web: {
      enabled: parsed?.web?.enabled ?? true,
      port: parsed?.web?.port ?? 3000,
      apiKey: parsed?.web?.apiKey ?? undefined,
    },
    persona: {
      enabled: parsed?.persona?.enabled ?? true,
      dir: parsed?.persona?.dir ?? "persona",
      botName: parsed?.persona?.botName ?? "Aelora",
      activePersona: parsed?.persona?.activePersona ?? "default",
    },
    heartbeat: {
      enabled: parsed?.heartbeat?.enabled ?? true,
      intervalMs: parsed?.heartbeat?.intervalMs ?? 60_000,
    },
    agents: {
      enabled: parsed?.agents?.enabled ?? true,
      maxIterations: parsed?.agents?.maxIterations ?? 5,
    },
    tools: parsed?.tools ?? {},
    activity: {
      enabled: parsed?.activity?.enabled ?? false,
      clientId: parsed?.activity?.clientId ?? "",
      clientSecret: parsed?.activity?.clientSecret ?? "",
      serverUrl: parsed?.activity?.serverUrl ?? "",
    },
  };

  // Environment variables override YAML values (secrets + port)
  applyEnvOverrides(config);

  // Validate required fields (after env overrides)
  if (!config.discord.token) {
    throw new Error("discord.token is required (set in settings.yaml or AELORA_DISCORD_TOKEN)");
  }
  if (!config.llm.baseURL) {
    throw new Error("llm.baseURL is required (set in settings.yaml or AELORA_LLM_BASE_URL)");
  }
  if (!config.llm.model) {
    throw new Error("llm.model is required (set in settings.yaml)");
  }

  return config;
}

function applyEnvOverrides(config: Config): void {
  const env = process.env;
  const applied: string[] = [];
  if (env.AELORA_DISCORD_TOKEN)          { config.discord.token = env.AELORA_DISCORD_TOKEN; applied.push("AELORA_DISCORD_TOKEN"); }
  if (env.AELORA_LLM_API_KEY)            { config.llm.apiKey = env.AELORA_LLM_API_KEY; applied.push("AELORA_LLM_API_KEY"); }
  if (env.AELORA_LLM_BASE_URL)           { config.llm.baseURL = env.AELORA_LLM_BASE_URL; applied.push("AELORA_LLM_BASE_URL"); }
  if (env.AELORA_WEB_API_KEY)            { config.web.apiKey = env.AELORA_WEB_API_KEY; applied.push("AELORA_WEB_API_KEY"); }
  if (env.AELORA_WEB_PORT)               { config.web.port = parseInt(env.AELORA_WEB_PORT, 10) || config.web.port; applied.push("AELORA_WEB_PORT"); }
  if (env.AELORA_ACTIVITY_CLIENT_ID)     { config.activity.clientId = env.AELORA_ACTIVITY_CLIENT_ID; applied.push("AELORA_ACTIVITY_CLIENT_ID"); }
  if (env.AELORA_ACTIVITY_CLIENT_SECRET) { config.activity.clientSecret = env.AELORA_ACTIVITY_CLIENT_SECRET; applied.push("AELORA_ACTIVITY_CLIENT_SECRET"); }
  if (applied.length > 0) {
    console.log(`Config: env overrides applied: ${applied.join(", ")}`);
  }
}

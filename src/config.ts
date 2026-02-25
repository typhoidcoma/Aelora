import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas — serve as both runtime validator AND TypeScript type source
// ---------------------------------------------------------------------------

const discordSchema = z.object({
  token: z.string().default(""),
  guildMode: z.enum(["mention", "all"]).default("mention"),
  allowedChannels: z.array(z.coerce.string()).default([]),
  allowDMs: z.boolean().default(true),
  status: z.string().default("Online"),
  guildId: z.string().optional(),
  embedColor: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const n = parseInt(String(v).replace("#", ""), 16);
      if (Number.isNaN(n) || n < 0 || n > 0xffffff) {
        throw new Error(`Invalid hex color: ${v}`);
      }
      return n;
    }),
  statusChannelId: z.string().optional(),
});

const llmSchema = z.object({
  baseURL: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().default(""),
  systemPrompt: z.string().default("You are a helpful assistant."),
  maxTokens: z.number().int().positive().default(1024),
  maxHistory: z.number().int().positive().default(20),
  maxToolIterations: z.number().int().positive().default(10),
  lite: z.boolean().default(false),
});

const memorySchema = z.object({
  maxFactsPerScope: z.number().int().positive().default(100),
  maxFactLength: z.number().int().positive().default(1000),
  maxAgeDays: z.number().int().nonnegative().default(0),
});

const loggerSchema = z.object({
  maxBuffer: z.number().int().positive().default(200),
  fileEnabled: z.boolean().default(false),
  retainDays: z.number().int().positive().default(7),
});

const cronSchema = z.object({
  maxHistory: z.number().int().positive().default(10),
});

const webSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1).max(65535).default(3000),
  apiKey: z.string().optional(),
});

const personaSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default("persona"),
  botName: z.string().default("Aelora"),
  activePersona: z.string().default("aelora"),
});

const heartbeatSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().int().positive().default(60_000),
});

const agentsSchema = z.object({
  enabled: z.boolean().default(true),
  maxIterations: z.number().int().positive().default(5),
});

const activitySchema = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string().default(""),
  clientSecret: z.string().default(""),
  serverUrl: z.string().default(""),
});

const configSchema = z.object({
  timezone: z.string().default("UTC"),
  discord: discordSchema,
  llm: llmSchema,
  web: webSchema.default({}),
  persona: personaSchema.default({}),
  heartbeat: heartbeatSchema.default({}),
  agents: agentsSchema.default({}),
  tools: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  activity: activitySchema.default({}),
  memory: memorySchema.default({}),
  logger: loggerSchema.default({}),
  cron: cronSchema.default({}),
});

export type Config = z.infer<typeof configSchema>;

// ---------------------------------------------------------------------------
// Load & validate
// ---------------------------------------------------------------------------

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

  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }

  const config = result.data;

  // Environment variables override YAML values (secrets + port)
  applyEnvOverrides(config);

  // Validate required fields (after env overrides, since secrets often come from env)
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
  if (env.AELORA_WEB_PORT) {
    const p = parseInt(env.AELORA_WEB_PORT, 10);
    if (!Number.isNaN(p)) { config.web.port = p; applied.push("AELORA_WEB_PORT"); }
  }
  if (env.AELORA_ACTIVITY_CLIENT_ID)     { config.activity.clientId = env.AELORA_ACTIVITY_CLIENT_ID; applied.push("AELORA_ACTIVITY_CLIENT_ID"); }
  if (env.AELORA_ACTIVITY_CLIENT_SECRET) { config.activity.clientSecret = env.AELORA_ACTIVITY_CLIENT_SECRET; applied.push("AELORA_ACTIVITY_CLIENT_SECRET"); }
  if (applied.length > 0) {
    console.log(`Config: env overrides applied: ${applied.join(", ")}`);
  }
}

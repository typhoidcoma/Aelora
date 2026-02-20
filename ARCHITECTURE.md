# Architecture

Technical reference for the Aelora bot. Covers every system, how they connect, and how to extend them.

## System Overview

```
                          ┌─────────────────────┐
                          │     Discord API      │
                          └──────────┬──────────┘
                                     │
                          ┌──────────▼──────────┐
                          │   discord/client.ts  │
                          │  Message routing,    │
                          │  slash commands,     │
                          │  attachments         │
                          └──────────┬──────────┘
                                     │
                          ┌──────────▼──────────┐
                          │       llm.ts         │
                          │  Conversation mgmt,  │
                          │  system prompt,      │
                          │  tool/agent loop     │
                          └───┬─────────────┬───┘
                              │             │
               ┌──────────────▼──┐    ┌─────▼──────────────┐
               │  tool-registry  │    │  agent-registry    │
               │  (auto-discover │    │  (auto-discover    │
               │   src/tools/)   │    │   src/agents/)     │
               └──────────────┬──┘    └─────┬──────────────┘
                              │             │
                     ┌────────▼─────────────▼────────┐
                     │        Tool handlers          │
                     │   ping · notes · calendar     │
                     └───────────────────────────────┘

  ┌────────────┐    ┌────────────┐    ┌────────────────────┐
  │  cron.ts   │    │ heartbeat  │    │      web.ts        │
  │  Scheduled │    │  Periodic  │    │  REST API + SSE    │
  │  messages  │    │  handlers  │    │  Dashboard UI      │
  └──────┬─────┘    └─────┬──────┘    └──────┬─────────────┘
         │                │                  │
         └───── sendToChannel / getLLMOneShot ┘
```

## Startup Sequence

Defined in [src/index.ts](src/index.ts). Runs 10 steps in order:

| Step | What | Module |
|------|------|--------|
| 1 | Install logger (patch console) | `logger.ts` |
| 2 | Load config from `settings.yaml` | `config.ts` |
| 3 | Load persona files → compose system prompt | `persona.ts` |
| 4 | Initialize LLM client | `llm.ts` |
| 5 | Auto-discover and load tools | `tool-registry.ts` |
| 6 | Auto-discover and load agents | `agent-registry.ts` |
| 7 | Connect to Discord, register slash commands | `discord/client.ts` |
| 8 | Start cron scheduler | `cron.ts` |
| 9 | Register heartbeat handlers, start ticker | `heartbeat.ts` |
| 10 | Start web dashboard, set system state provider | `web.ts`, `llm.ts` |

Graceful shutdown on SIGINT: stops heartbeat, stops cron, exits.

---

## Message Flow

### Chat Messages (plain text responses)

```
1. Discord MessageCreate event
2. client.ts: handleMessage()
   - Ignores own messages and other bots
   - Checks guild mode (mention/all) and channel filters
   - Strips @mention prefix from content
   - channel.sendTyping() (shows "typing..." indicator)
   - processAttachments() → string or ContentPart[] (vision/text)
3. llm.ts: getLLMResponse(channelId, userContent)
   - Retrieves per-channel history from Map
   - Appends user message, trims to maxHistory
   - buildSystemPrompt() — persona base + system status + tool/agent inventory
   - runCompletionLoop(messages, tools, channelId)
     Loop (up to 10 iterations):
       → client.chat.completions.create()
       → If tool_calls: dispatch each to agent or tool, push results, continue
       → If text: return final response
   - Appends assistant response to history
4. client.ts: chunkMessage(text, 2000)
   - Splits response for Discord's 2000-char limit
   - message.reply(first chunk), channel.send(remaining chunks)
```

### Slash Commands (embed responses)

```
1. Discord InteractionCreate event
2. client.ts: handleSlashCommand()
   /ask [prompt]  → deferReply → getLLMResponse() → buildResponseEmbed()
   /tools         → getAllTools() + getAllAgents() → buildToolListEmbed()
   /ping          → latency measurement → buildSuccessEmbed()
   /reboot        → reply embed → setTimeout(500ms) → reboot()
```

Chat messages respond with **plain text**. The `/ask` slash command responds with **rich embeds**.

---

## LLM System

**File:** [src/llm.ts](src/llm.ts)

### Client

Uses the `openai` npm package. Any OpenAI-compatible endpoint works — configured via `llm.baseURL` and `llm.apiKey` in settings.

### Conversation History

- Stored in a `Map<string, ChatMessage[]>` keyed by Discord channel ID
- Each channel has independent history
- Trimmed to `maxHistory` (default 20) messages after each exchange
- **In-memory only** — lost on restart, isolated per channel

### System Prompt Composition

`buildSystemPrompt()` assembles the prompt fresh on every request:

```
[Persona composed prompt]

## System Status
- Bot: Aelora (Aelora#1234)
- Discord: connected, 1 guild(s)
- Model: gpt-5-mini-2025-08-07
- Uptime: 2h 15m
- Heartbeat: running, 1 handler(s)
- Cron: 0 active job(s)

## Currently Available

### Tools
- **ping** — Responds with pong and server time
- **notes** — Save, retrieve, list, and delete notes
- **calendar** — Manage calendar events via CalDAV

### Agents
(none currently)
```

This gives the LLM live awareness of its environment.

### Tool Calling Loop

`runCompletionLoop()` — up to `MAX_TOOL_ITERATIONS` (10) rounds:

1. Call `client.chat.completions.create()` with messages + tool definitions
2. If response has `tool_calls`: parse args, dispatch each to tool or agent, push results, loop
3. If response is text: return as final answer
4. Safety cap: returns error message if loop exceeds max iterations

### One-Shot Mode

`getLLMOneShot(prompt)` — stateless call with full tool support. Used by:
- Cron jobs (`type: "llm"`)
- Web dashboard LLM test
- Agent sub-loops

### Agent Loop

`runAgentLoop(options)` — sub-completion-loop with:
- Agent's own system prompt (not the persona prompt)
- Tool allowlist: `undefined` = no tools, `["*"]` = all tools, `["a", "b"]` = specific tools
- `allowAgentDispatch = false` — agents cannot call other agents (prevents recursion)
- Optional model override (agents can use a different LLM)

---

## Persona System

**Files:** [src/persona.ts](src/persona.ts), [persona/](persona/)

### How It Works

1. `loadPersona(dir, variables, activeMode)` recursively discovers all `.md` files under the persona directory
2. Files under `modes/` are filtered — only the active mode's folder is included (e.g. `modes/default/`). Shared files outside `modes/` are always loaded.
3. Each file's YAML frontmatter is parsed for metadata:
   - `order` (number) — sort priority (lower = earlier in prompt)
   - `enabled` (boolean) — whether to include in composed prompt
   - `label` (string) — display name for dashboard
   - `section` (string) — grouping category
4. Files are sorted by `order`, then alphabetically within the same order
5. Enabled files are concatenated with `\n\n` separators
6. Template variables (e.g. `{{botName}}`) are substituted from config

### Mode System

Each persona mode is a folder under `persona/modes/`. The active mode is controlled by `persona.activeMode` in `settings.yaml` (default: `"default"`). Each mode folder contains:

- `mode.md` — persona description and behavioral framing
- `soul.md` — the mode's behavioral core, directives, and personality traits

Files in non-active mode folders are simply not loaded — no `enabled: false` needed.

### Current File Inventory (default mode)

| Order | File | Section | Enabled |
|-------|------|---------|---------|
| 5 | `bootstrap.md` | bootstrap | yes |
| 10 | `identity.md` | identity | yes |
| 20 | `modes/default/soul.md` | soul | yes |
| 50 | `skills/creative-writing.md` | skill | yes |
| 51 | `skills/worldbuilding.md` | skill | yes |
| 80 | `tools.md` | tools | yes |
| 90 | `modes/default/mode.md` | persona | yes |
| 200 | `templates/user.md` | template | no |

### Hot Reload

`POST /api/persona/reload` re-reads all files from disk and updates the live system prompt. No restart needed. Available from the web dashboard.

---

## Tool System

**Files:** [src/tool-registry.ts](src/tool-registry.ts), [src/tools/types.ts](src/tools/types.ts)

### Auto-Discovery

On startup, `loadTools()` scans `src/tools/` for `.ts`/`.js` files:
- Skips `types.ts` and files prefixed with `_`
- Dynamic-imports each file
- Validates that it exports a `Tool` object with `definition.name` and `handler`
- Registers in the module-level `Map<string, RegisteredTool>`

### `defineTool()` API

The recommended way to create tools. Handles JSON Schema generation, argument validation, and config resolution:

```typescript
import { defineTool, param } from "./types.js";

export default defineTool({
  name: "my-tool",
  description: "What this tool does.",

  // Params auto-generate OpenAI function-calling JSON Schema
  params: {
    action: param.enum("The action.", ["list", "create"] as const, { required: true }),
    title:  param.string("Item title.", { required: true }),
    count:  param.number("How many.", { minimum: 1, maximum: 100 }),
    tags:   param.array("Tags.", { itemType: "string" }),
    draft:  param.boolean("Is draft."),
  },

  // Config keys resolved from settings.yaml `tools:` section
  config: ["myservice.apiKey", "myservice.baseUrl"],

  handler: async (args, ctx) => {
    // args is typed: { action, title, count, tags, draft }
    // ctx.toolConfig has resolved config values
    // ctx.channelId, ctx.sendToChannel() available
    return "result string";
  },
});
```

**`param` helpers:** `param.string()`, `param.number()`, `param.boolean()`, `param.enum()`, `param.array()` — each returns a `ParamSchema` with JSON Schema metadata and a `_required` flag.

### Config Resolution

Tools declare config dependencies as dotted paths (e.g. `["caldav.serverUrl", "caldav.password"]`). At runtime, `defineTool()` resolves these from the `tools:` section of `settings.yaml`:

```yaml
tools:
  caldav:
    serverUrl: "http://localhost:5232"
    password: "secret"
```

If required config keys are missing, the tool returns an error message instead of executing.

### Runtime Toggle

Tools can be enabled/disabled at runtime via `POST /api/tools/:name/toggle` or the web dashboard. Changes are in-memory only (revert on restart).

### Current Tools

| Tool | Description | Config |
|------|-------------|--------|
| `ping` | Responds with pong + server time | none |
| `notes` | Persistent note storage (save/get/list/delete) | none |
| `calendar` | CalDAV calendar CRUD (list/create/update/delete) | `caldav.*` |

---

## Agent System

**Files:** [src/agent-registry.ts](src/agent-registry.ts), [src/agents/types.ts](src/agents/types.ts)

### How Agents Work

Agents are presented to the LLM as function calls, identical to tools. When the LLM calls an agent:

1. `isAgent(name)` detects it's an agent, not a tool
2. `executeAgent()` calls `runAgentLoop()` — a sub-completion-loop with:
   - The agent's own system prompt
   - The call arguments as user prompt
   - Filtered tool definitions based on the agent's `tools` allowlist
   - `allowAgentDispatch = false` (no recursive agent calls)
3. Optional `postProcess(rawOutput, args)` transforms the result
4. Result is returned to the main LLM as a tool response

### AgentDefinition

```typescript
{
  name: string;              // Unique identifier
  description: string;       // Shown to the LLM
  parameters?: {...};        // JSON Schema for agent arguments
  systemPrompt: string;      // Agent's own system prompt
  tools?: string[];          // Tool allowlist: undefined=none, ["*"]=all, ["a","b"]=specific
  maxIterations?: number;    // Override default (config.agents.maxIterations)
  model?: string;            // Override default LLM model
}
```

No concrete agents exist yet — the framework is ready for use.

---

## Heartbeat System

**Files:** [src/heartbeat.ts](src/heartbeat.ts), [src/heartbeat-calendar.ts](src/heartbeat-calendar.ts)

A periodic tick system that runs registered handlers at a configurable interval (default: 60 seconds).

### Handler Interface

```typescript
type HeartbeatHandler = {
  name: string;
  description: string;
  enabled: boolean;
  execute: (ctx: HeartbeatContext) => Promise<void>;
};

type HeartbeatContext = {
  sendToChannel: (channelId: string, text: string) => Promise<void>;
  llmOneShot: (prompt: string) => Promise<string>;
  config: Config;
};
```

Handlers receive Discord send capability, LLM access, and full config. They run sequentially on each tick, with errors caught per-handler.

### Calendar Reminder Handler

The built-in `calendar-reminder` handler ([src/heartbeat-calendar.ts](src/heartbeat-calendar.ts)):

- Every tick: connects to CalDAV, fetches events starting within 15 minutes
- Sends a formatted reminder to the guild's first text channel
- Tracks notified events by UID to avoid duplicates
- Silently skips if CalDAV is not configured

### Adding a Handler

```typescript
import { registerHeartbeatHandler } from "./heartbeat.js";

registerHeartbeatHandler({
  name: "my-handler",
  description: "Does something periodically.",
  enabled: true,
  execute: async (ctx) => {
    // ctx.sendToChannel(), ctx.llmOneShot(), ctx.config
  },
});
```

Call `registerHeartbeatHandler()` before `startHeartbeat()` in [src/index.ts](src/index.ts).

---

## Cron System

**File:** [src/cron.ts](src/cron.ts)

Schedules jobs from the `cron.jobs` array in settings. Uses the `croner` library (cron expressions with timezone support).

### Job Types

| Type | Behavior |
|------|----------|
| `static` | Sends `job.message` literally to the configured channel |
| `llm` | Sends `job.prompt` to `getLLMOneShot()`, posts the LLM's response |

LLM-type jobs have full tool support — the LLM can call tools while generating the response.

### Configuration

```yaml
cron:
  jobs:
    - name: "Good morning"
      schedule: "0 9 * * *"
      timezone: "America/New_York"
      channelId: "123456789"
      type: "static"
      message: "Good morning everyone!"
      enabled: true

    - name: "Daily wisdom"
      schedule: "0 12 * * *"
      timezone: "America/New_York"
      channelId: "123456789"
      type: "llm"
      prompt: "Generate a short piece of wisdom. Keep it under 200 words."
      enabled: true
```

### State Tracking

Each job maintains `CronJobState`: name, schedule, last run, next run, last error. Exposed via `GET /api/cron` and the web dashboard.

---

## Discord Integration

**Directory:** [src/discord/](src/discord/)

### client.ts

- Creates a `Client` with intents: Guilds, GuildMessages, MessageContent, DirectMessages
- On ready: sets bot status, registers slash commands (guild-scoped if `guildId` set, otherwise global)
- Message routing filters: ignores bots, respects `allowedChannels`, `guildMode`, `allowDMs`
- Exports `discordClient`, `botUserId`, `startDiscord()`, `sendToChannel()`

### commands.ts

Four slash commands, registered on startup:

| Command | Description |
|---------|-------------|
| `/ask [prompt]` | Ask Aelora with a rich embed response |
| `/tools` | List all tools and agents with status |
| `/ping` | Latency check |
| `/reboot` | Graceful restart |

### attachments.ts

`processAttachments(message, textContent, model)`:

- **Images** (PNG/JPEG/GIF/WebP) on vision-capable models → `ContentPart` with `image_url`
- **Text files** (26 supported extensions, up to 100 KB) → downloaded and inlined
- **Other files** → placeholder noting the file type

### embeds.ts

Builders for Discord embeds:
- `buildResponseEmbed(text, model)` — accent-colored, splits at 4096 chars
- `buildErrorEmbed(msg)` — red
- `buildSuccessEmbed(text)` — green
- `buildToolListEmbed(tools, agents)` — formatted list with status indicators

---

## Web Dashboard

**Files:** [src/web.ts](src/web.ts), [public/](public/)

Express 5 server serving the dashboard frontend and REST API.

### API Routes

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/status` | Bot connection state, uptime, guild count |
| `GET` | `/api/config` | Sanitized config (no secrets) |
| `GET` | `/api/persona` | Persona file inventory, active mode + prompt stats |
| `POST` | `/api/persona/reload` | Hot-reload persona files from disk |
| `POST` | `/api/llm/test` | One-shot LLM test call |
| `GET` | `/api/tools` | All tools with enabled status |
| `POST` | `/api/tools/:name/toggle` | Enable/disable a tool |
| `GET` | `/api/agents` | All agents with config |
| `POST` | `/api/agents/:name/toggle` | Enable/disable an agent |
| `GET` | `/api/cron` | Cron job states |
| `GET` | `/api/heartbeat` | Heartbeat state + handler list |
| `GET` | `/api/logs` | Recent 200 log entries |
| `GET` | `/api/logs/stream` | SSE live log stream |
| `POST` | `/api/reboot` | Trigger graceful reboot |

### Frontend

Single-page vanilla JS app in `public/`. Dark design (#0c0c0e), Roboto font, purple accent (#a78bfa). Collapsible panels for each section. Live console via SSE `EventSource`. All controls (toggle, reload, reboot, LLM test) hit the REST API.

---

## Config System

**File:** [src/config.ts](src/config.ts)

`loadConfig()` reads `settings.yaml`, validates required keys (`discord.token`, `llm.baseURL`, `llm.model`), and returns a typed `Config` object with defaults applied.

### Config Type

```typescript
type Config = {
  discord: {
    token: string;
    guildMode: "mention" | "all";
    allowedChannels: string[];
    allowDMs: boolean;
    status: string;
    guildId?: string;
    embedColor?: number;
  };
  llm: {
    baseURL: string;
    apiKey: string;
    model: string;
    systemPrompt: string;     // Overwritten by soul system at startup
    maxTokens: number;        // Default: 1024
    maxHistory: number;       // Default: 20
  };
  cron: { jobs: CronJobConfig[] };
  web: { enabled: boolean; port: number };
  persona: { enabled: boolean; dir: string; botName: string; activeMode: string };
  heartbeat: { enabled: boolean; intervalMs: number };
  agents: { enabled: boolean; maxIterations: number };
  tools: Record<string, Record<string, unknown>>;  // Free-form per-tool config
};
```

---

## Supporting Systems

### boot.ts — Process Wrapper

[src/boot.ts](src/boot.ts) spawns `index.ts` (or `index.js` in production) as a child process. If the child exits with code **100**, it restarts automatically. Any other exit code propagates normally. This enables graceful reboots from Discord (`/reboot`) and the web dashboard without external process managers.

### lifecycle.ts — Reboot

`reboot()` stops heartbeat, stops cron, then calls `process.exit(100)`. The boot wrapper catches code 100 and restarts.

### logger.ts — Console Capture

`installLogger()` patches `console.log`, `console.warn`, `console.error` at startup. Every call:
1. Passes through to the original console method (terminal output)
2. Pushes a `LogEntry` into a 200-entry circular buffer
3. Broadcasts the entry as an SSE event to all connected dashboard clients

### utils.ts — Shared Utilities

`chunkMessage(text, maxLength = 2000)` — splits text into Discord-safe chunks, respecting newline boundaries where possible.

---

## State & Persistence

| Data | Storage | Survives restart? |
|------|---------|-------------------|
| Conversation history | In-memory Map (per channel) | No |
| Notes | `data/notes.json` (disk) | Yes |
| Calendar events | External CalDAV server | Yes |
| Tool/agent enabled state | In-memory registry | No (resets to code defaults) |
| Cron job state | In-memory (rebuilt from config) | No |
| Heartbeat notified events | In-memory Set | No |
| Log buffer | In-memory circular array (200 entries) | No |
| Persona files | Disk (`persona/` directory) | Yes |

---

## Extension Guide

### Adding a Tool

1. Create `src/tools/my-tool.ts`
2. Use `defineTool()` with typed params and a handler
3. If it needs config, add keys to `config: [...]` and matching entries in `settings.yaml` under `tools:`
4. Restart the bot — it auto-loads
5. Verify in console: `Tools: loaded "my-tool" (enabled)`

### Adding an Agent

1. Create `src/agents/my-agent.ts`
2. Export an `Agent` object with `definition` (including `systemPrompt`) and `enabled: true`
3. Set `tools` to control which tools the agent can use
4. Optionally add `postProcess()` to transform raw LLM output
5. Restart — auto-loads. Verify in console.

### Adding a Heartbeat Handler

1. Create a handler object implementing `HeartbeatHandler`
2. Call `registerHeartbeatHandler()` before `startHeartbeat()` in `index.ts`
3. Handler runs on every tick (default: 60s). Use `enabled` flag to toggle.

### Adding a Persona File

1. Create a `.md` file anywhere under `persona/` (for shared content) or `persona/modes/<mode>/` (for mode-specific content)
2. Add YAML frontmatter: `order`, `enabled`, `label`, `section`
3. Hot-reload from dashboard or restart the bot
4. File content is injected into the system prompt at the specified order position

### Adding a Cron Job

Add an entry to `settings.yaml` under `cron.jobs`:

```yaml
cron:
  jobs:
    - name: "My Job"
      schedule: "*/30 * * * *"    # Every 30 minutes
      timezone: "UTC"
      channelId: "CHANNEL_ID"
      type: "llm"                 # or "static"
      prompt: "Generate something interesting."
      enabled: true
```

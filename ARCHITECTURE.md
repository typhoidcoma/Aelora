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
                     │  ping · notes · calendar ·    │
                     │  brave-search · cron · memory │
                     └──────────────┬────────────────┘
                                    │
                     ┌──────────────▼────────────────┐
                     │       Persistence layer       │
                     │  memory.ts · sessions.ts ·    │
                     │  data/*.json                  │
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
3. llm.ts: getLLMResponse(channelId, userContent, onToken, userId)
   - Retrieves per-channel history from Map
   - Appends user message, trims to maxHistory
   - buildSystemPrompt(userId, channelId) — persona base + system status + tool/agent inventory + memory
   - runCompletionLoop(messages, tools, channelId, onToken, userId)
     Loop (up to 10 iterations):
       → client.chat.completions.create({ stream: true })
       → Tokens streamed via onToken callback
       → If tool_calls: dispatch each to agent or tool, push results, continue
       → If text: return final response
   - Appends assistant response to history
4. client.ts: Streaming response
   - Sends initial reply, then edits the message as tokens arrive
   - Chunks are buffered and the Discord message is updated periodically
   - Final message is split via chunkMessage(text, 2000) if needed
```

### Slash Commands (embed responses)

```
1. Discord InteractionCreate event
2. client.ts: handleSlashCommand()
   /ask [prompt]     → deferReply → getLLMResponse() → buildResponseEmbed()
   /tools            → getAllTools() + getAllAgents() → buildToolListEmbed()
   /ping             → latency measurement → buildSuccessEmbed()
   /clear            → clearHistory(channelId) → buildSuccessEmbed()
   /websearch [query]→ executeTool("brave-search") → buildResponseEmbed()
   /reboot           → reply embed → setTimeout(500ms) → reboot()
```

Chat messages respond with **streaming plain text**. Slash commands respond with **rich embeds**.

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

`buildSystemPrompt(userId?, channelId?)` assembles the prompt fresh on every request:

```
[Persona composed prompt]

## System Status
- Bot: Aelora (Aelora#1234)
- Discord: connected, 1 guild(s)
- Model: gpt-5-mini-2025-08-07
- Uptime: 2h 15m
- Heartbeat: running, 1 handler(s)
- Cron: 2 active job(s)

## Currently Available

### Tools
- **ping** — Responds with pong and server time
- **notes** — Save, retrieve, list, and delete notes
- **calendar** — Manage calendar events via CalDAV
- **brave-search** — Search the web via Brave Search API
- **cron** — Create, list, toggle, trigger, and delete scheduled jobs
- **memory** — Remember and recall facts about users and channels

### Agents
(none currently)

## Memory
### About this user
- Prefers casual tone
- Working on a Rust game engine
### About this channel
- This channel discusses AI news
```

The memory section is conditionally injected by `getMemoryForPrompt(userId, channelId)` — only appears when relevant facts exist. This gives the LLM live awareness of its environment and persistent knowledge about users and channels.

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

1. `loadPersona(dir, variables, activePersona)` discovers all `.md` files under the active persona's directory (e.g. `persona/default/`)
2. Each file's YAML frontmatter is parsed for metadata:
   - `order` (number) — sort priority (lower = earlier in prompt)
   - `enabled` (boolean) — whether to include in composed prompt
   - `label` (string) — display name for dashboard
   - `section` (string) — grouping category
   - `botName` (string) — character name (used in `persona.md` to define the character's identity)
3. Files are sorted by `order`, then alphabetically within the same order
4. Enabled files are concatenated with `\n\n` separators
5. `botName` is resolved from the active persona's `persona.md` frontmatter, falling back to `persona.botName` in config
6. Template variables (e.g. `{{botName}}`) are substituted with the resolved character name

### Personas — Character Entities

Each persona is a **self-contained character** — a directory under `persona/` with its own identity, personality, bootstrap rules, skills, and tools. The active persona is controlled by `persona.activePersona` in `settings.yaml` (default: `"default"`). Only the active persona's directory is loaded — all other persona directories are ignored.

Each persona directory contains:

- `persona.md` — persona description and behavioral framing; frontmatter includes `botName` (the character's display name) and `description`
- `identity.md` — the character's identity, backstory, and lore
- `soul.md` — the character's behavioral core, directives, and personality traits
- `bootstrap.md` — response format rules and operating instructions
- `tools.md` — tool/agent usage instructions
- `skills.md` — the character's specialized skills and competencies

### Current File Inventory (default persona)

| Order | File | Section | Enabled |
|-------|------|---------|---------|
| 5 | `default/bootstrap.md` | bootstrap | yes |
| 10 | `default/identity.md` | identity | yes |
| 20 | `default/soul.md` | soul | yes |
| 50 | `default/skills.md` | skill | yes |
| 80 | `default/tools.md` | tools | yes |
| 90 | `default/persona.md` | persona | yes |
| 200 | `default/templates/user.md` | template | no |

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
| `brave-search` | Web search via Brave Search API | `brave.apiKey` |
| `cron` | Create, list, toggle, trigger, delete cron jobs at runtime | none |
| `memory` | Remember/recall/forget facts about users and channels | none |

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

Schedules jobs from two sources: config-based jobs (from `settings.yaml`) and runtime-created jobs (via the `cron` tool or REST API). Uses the `croner` library (cron expressions with timezone support).

### Job Sources

| Source | Created via | Editable at runtime? | Persistence |
|--------|-------------|----------------------|-------------|
| `config` | `cron.jobs` in `settings.yaml` | No (read-only) | `settings.yaml` |
| `runtime` | `cron` tool or `POST /api/cron` | Yes (full CRUD) | `data/cron-jobs.json` |

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

### Runtime Job Management

Runtime jobs can be created, updated, toggled, triggered, and deleted through:
- The `cron` tool (LLM-accessible, used during conversations)
- REST API (`POST/PUT/DELETE /api/cron/...`)
- Web dashboard UI

Runtime jobs persist to `data/cron-jobs.json` and are restored on restart. Each job maintains up to 10 execution history records with timestamps, duration, output preview, and error status.

### State Tracking

Each job maintains `CronJobState`: name, schedule, last run, next run, last error, execution history. Exposed via `GET /api/cron` and the web dashboard.

---

## Discord Integration

**Directory:** [src/discord/](src/discord/)

### client.ts

- Creates a `Client` with intents: Guilds, GuildMessages, MessageContent, DirectMessages
- On ready: sets bot status, registers slash commands (guild-scoped if `guildId` set, otherwise global)
- Message routing filters: ignores bots, respects `allowedChannels`, `guildMode`, `allowDMs`
- Exports `discordClient`, `botUserId`, `startDiscord()`, `sendToChannel()`

### commands.ts

Six slash commands, registered on startup:

| Command | Description |
|---------|-------------|
| `/ask [prompt]` | Ask Aelora with a rich embed response |
| `/tools` | List all tools and agents with status |
| `/ping` | Latency check |
| `/clear` | Clear conversation history for this channel |
| `/websearch [query]` | Search the web via Brave Search |
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
| `GET` | `/api/persona` | Active persona state, file inventory, prompt stats |
| `POST` | `/api/persona/reload` | Hot-reload persona files from disk |
| `GET` | `/api/personas` | List all personas with descriptions |
| `POST` | `/api/persona/switch` | Switch active persona |
| `POST` | `/api/personas` | Create a new persona (with botName) |
| `DELETE` | `/api/personas/:name` | Delete a persona |
| `GET` | `/api/persona/files` | List all files with metadata |
| `GET` | `/api/persona/file?path=...` | Get a file's content and metadata |
| `POST` | `/api/persona/file` | Create a new persona file |
| `PUT` | `/api/persona/file` | Update an existing persona file |
| `DELETE` | `/api/persona/file?path=...` | Delete a persona file |
| `POST` | `/api/llm/test` | One-shot LLM test call |
| `POST` | `/api/llm/test/stream` | Streaming LLM test (SSE) |
| `GET` | `/api/tools` | All tools with enabled status |
| `POST` | `/api/tools/:name/toggle` | Enable/disable a tool |
| `GET` | `/api/agents` | All agents with config |
| `POST` | `/api/agents/:name/toggle` | Enable/disable an agent |
| `GET` | `/api/cron` | Cron job list with state |
| `POST` | `/api/cron` | Create a new runtime cron job |
| `PUT` | `/api/cron/:name` | Update a runtime cron job |
| `POST` | `/api/cron/:name/toggle` | Enable/disable a cron job |
| `POST` | `/api/cron/:name/trigger` | Manually trigger a cron job |
| `DELETE` | `/api/cron/:name` | Delete a runtime cron job |
| `GET` | `/api/sessions` | All active conversation sessions |
| `DELETE` | `/api/sessions/:channelId` | Delete a specific session |
| `DELETE` | `/api/sessions` | Clear all sessions |
| `GET` | `/api/memory` | All stored memory facts |
| `DELETE` | `/api/memory/:scope/:index` | Delete a specific fact |
| `DELETE` | `/api/memory/:scope` | Clear all facts in a scope |
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
  persona: { enabled: boolean; dir: string; botName: string; activePersona: string };
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
| Cron jobs (config) | `settings.yaml` | Yes |
| Cron jobs (runtime) | `data/cron-jobs.json` (disk) | Yes |
| Cron execution history | `data/cron-jobs.json` (disk) | Yes |
| Memory facts | `data/memory.json` (disk) | Yes |
| Sessions | `data/sessions.json` (disk) | Yes |
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

1. Create a `.md` file inside the target persona's directory (e.g. `persona/default/my-file.md`)
2. Add YAML frontmatter: `order`, `enabled`, `label`, `section`
3. Hot-reload from dashboard or restart the bot
4. File content is injected into the system prompt at the specified order position

### Adding a New Character

1. From the dashboard Persona section, click **+ Create** and fill in a Character Name, Folder Name, and Description
2. Or via API: `POST /api/personas` with `{ "name": "my-char", "description": "...", "botName": "My Character" }`
3. This creates a self-contained persona directory with template files: `persona.md`, `identity.md`, `soul.md`, `bootstrap.md`
4. Edit the generated files to define the character's identity, backstory, and behavioral core
5. Switch to the new character from the dashboard card grid or via `POST /api/persona/switch`
6. The `{{botName}}` variable resolves to this character's name automatically

### Adding a Cron Job

**Option 1: Config-based** — add to `settings.yaml` under `cron.jobs`:

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

**Option 2: Runtime** — create via the REST API (`POST /api/cron`), the web dashboard, or ask the bot to create one using the `cron` tool. Runtime jobs persist to `data/cron-jobs.json` and survive restarts.

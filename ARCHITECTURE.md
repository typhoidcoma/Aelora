# Architecture

Technical reference for the Aelora 🦋 bot. Covers every system, how they connect, and how to extend them.

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

  ┌────────────┐    ┌────────────┐    ┌─────────────────────┐
  │  cron.ts   │    │ heartbeat  │    │       web.ts        │
  │  Scheduled │    │  Periodic  │    │  REST API + SSE     │
  │  messages  │    │  handlers  │    │  Dashboard + Activity│
  └──────┬─────┘    └─────┬──────┘    └──────┬──────────────┘
         │                │                  │
         └───── sendToChannel / getLLMOneShot ┘

  ┌───────────────────────────────────────────────────────┐
  │              Discord Activity (optional)              │
  │  activity/index.html → SDK + OAuth2 + Unity WebGL    │
  │  /.proxy/ routing │ token exchange │ bridge API       │
  └───────────────────────────────────────────────────────┘
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
   /play             → embed + Link button → discord.com/activities/{appId}
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
- Model: gpt-5.1-chat-latest
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

1. `loadPersona(dir, variables, activePersona)` discovers all `.md` files under the active persona's directory (e.g. `persona/aelora/`)
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

Each persona is a **self-contained character** — a directory under `persona/` with its own identity, personality, bootstrap rules, skills, and tools. The active persona is controlled by `persona.activePersona` in `settings.yaml` (default: `"aelora"`). Only the active persona's directory is loaded — all other persona directories are ignored.

Each persona directory contains:

- `persona.md` — persona description and behavioral framing; frontmatter includes `botName` (the character's display name) and `description`
- `identity.md` — the character's identity, backstory, and lore
- `soul.md` — the character's behavioral core, directives, and personality traits
- `bootstrap.md` — response format rules and operating instructions
- `tools.md` — tool/agent usage instructions
- `skills.md` — the character's specialized skills and competencies

### Current File Inventory (aelora persona)

| Order | File | Section | Enabled |
|-------|------|---------|---------|
| 5 | `aelora/bootstrap.md` | bootstrap | yes |
| 10 | `aelora/identity.md` | identity | yes |
| 20 | `aelora/soul.md` | soul | yes |
| 50 | `aelora/skills.md` | skill | yes |
| 80 | `aelora/tools.md` | tools | yes |
| 90 | `aelora/persona.md` | persona | yes |
| 200 | `aelora/templates/user.md` | template | no |

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

**`param` helpers:** `param.string()`, `param.number()`, `param.boolean()`, `param.enum()`, `param.array()`, `param.object()`, `param.date()` — each returns a `ParamSchema` with JSON Schema metadata and a `_required` flag.

#### `param.object()` — Structured nested data

```typescript
metadata: param.object("Task metadata.", {
  required: true,
  properties: {
    priority: param.enum("Priority level.", ["low", "medium", "high"] as const),
    tags: param.array("Tags.", { itemType: "string" }),
  },
  requiredFields: ["priority"],  // Optional — defaults to inferring from _required flags
}),
```

Produces a valid OpenAI JSON Schema `object` type with nested properties. The `properties` parameter accepts the same `ParamSchema` helpers used at the top level.

#### `param.date()` — Date/datetime strings

```typescript
dueDate: param.date("When the task is due."),
startDate: param.date("Start date.", { format: "date" }),  // YYYY-MM-DD only
```

Emits a `string` type with a format hint appended to the description. Defaults to ISO 8601 datetime (`format: "date-time"`). Use `format: "date"` for date-only values.

#### `requireContext()` — Context validation helper

Validates that required context fields (like `userId`, `channelId`) are present. Returns `null` on success or an `"Error: ..."` string on failure — designed to be returned directly from a handler.

```typescript
import { defineTool, param, requireContext } from "./types.js";

handler: async (args, ctx) => {
  const err = requireContext(ctx, "userId", "channelId");
  if (err) return err;
  // ctx.userId and ctx.channelId are guaranteed non-null here
}
```

#### Multi-Action Tool Pattern

Most tools use a single `action` enum param with a `switch` statement. See `src/tools/_example-multi-action.ts` for a complete template. Key conventions:

1. **Action enum**: Always `required: true`, first param
2. **Conditional required params**: Validate inside each `case` branch, not at the param level
3. **Context validation**: Use `requireContext()` at the top of the handler
4. **Error format**: Always return `"Error: ..."` strings (never throw from a handler)
5. **Default branch**: Always include a `default:` case returning `"Error: unknown action ..."`

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

Schedules jobs from `data/cron-jobs.json`. Jobs are created via the `cron` tool, REST API, or web dashboard. Uses the `croner` library (cron expressions with timezone support).

### Job Types

| Type | Behavior |
|------|----------|
| `static` | Sends `job.message` literally to the configured channel |
| `llm` | Sends `job.prompt` to `getLLMOneShot()`, posts the LLM's response |

LLM-type jobs have full tool support — the LLM can call tools while generating the response. LLM-type jobs use the active persona's system prompt.

### Job Management

Jobs can be created, updated, toggled, triggered, and deleted through:
- The `cron` tool (LLM-accessible, used during conversations)
- REST API (`POST/PUT/DELETE /api/cron/...`)
- Web dashboard UI

Jobs persist to `data/cron-jobs.json` and are restored on restart. Each job maintains up to 10 execution history records with timestamps, duration, output preview, and error status.

### State Tracking

Each job maintains `CronJobState`: name, schedule, last run, next run, last error, execution history. Exposed via `GET /api/cron` and the web dashboard.

---

## Discord Integration

**Directory:** [src/discord/](src/discord/)

### client.ts

- Creates a `Client` with intents: Guilds, GuildMessages, MessageContent, DirectMessages
- On ready: sets bot status, registers slash commands (guild-scoped if `guildId` set, otherwise global)
- Preserves Discord-managed commands (e.g. Activity Entry Point) during bulk registration by fetching existing non-slash commands and including them in the update
- Message routing filters: ignores bots, respects `allowedChannels`, `guildMode`, `allowDMs`
- Exports `discordClient`, `botUserId`, `startDiscord()`, `sendToChannel()`

### commands.ts

Seven slash commands, registered on startup:

| Command | Description |
|---------|-------------|
| `/ask [prompt]` | Ask Aelora with a rich embed response |
| `/tools` | List all tools and agents with status |
| `/ping` | Latency check |
| `/clear` | Clear conversation history for this channel |
| `/websearch [query]` | Search the web via Brave Search |
| `/reboot` | Graceful restart |
| `/play` | Launch the Discord Activity (embed with Link button) |

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
| `GET` | `/api/sessions/:channelId` | Session detail with per-user stats and related memory facts |
| `DELETE` | `/api/sessions/:channelId` | Delete a specific session |
| `DELETE` | `/api/sessions` | Clear all sessions |
| `GET` | `/api/memory` | All stored memory facts |
| `DELETE` | `/api/memory/:scope/:index` | Delete a specific fact |
| `DELETE` | `/api/memory/:scope` | Clear all facts in a scope |
| `GET` | `/api/heartbeat` | Heartbeat state + handler list |
| `GET` | `/api/logs` | Recent 200 log entries |
| `GET` | `/api/logs/stream` | SSE live log stream |
| `POST` | `/api/reboot` | Trigger graceful reboot |
| `GET` | `/api/activity/config` | Activity client ID (no secret exposed) |
| `POST` | `/api/activity/token` | OAuth2 code→token exchange for Activity SDK |

### Routing

When `activity.enabled` is true:
- `/` serves `activity/index.html` with injected config (clientId, serverUrl) — this is what Discord's Activity iframe loads
- `/dashboard` serves the web dashboard (`public/index.html`)
- `/activity/*` serves Unity build files with CORS headers and gzip `Content-Encoding` for `.gz` files

When `activity.enabled` is false:
- `/` serves the web dashboard normally

### Frontend

Single-page vanilla JS app in `public/`. Dark design (#0c0c0e), Roboto font, purple accent (#a78bfa). Collapsible panels for each section. Live console via SSE `EventSource`. All controls (toggle, reload, reboot, LLM test) hit the REST API. Includes an **Activity Preview** panel that loads the Unity WebGL test page in an iframe (uses stub Discord data).

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
  web: { enabled: boolean; port: number };
  persona: { enabled: boolean; dir: string; botName: string; activePersona: string };
  heartbeat: { enabled: boolean; intervalMs: number };
  agents: { enabled: boolean; maxIterations: number };
  tools: Record<string, Record<string, unknown>>;  // Free-form per-tool config
  activity: {
    enabled: boolean;           // Default: false
    clientId: string;           // Discord Application ID
    clientSecret: string;       // OAuth2 Client Secret
    serverUrl: string;          // Optional direct server URL
  };
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
| Cron jobs + execution history | `data/cron-jobs.json` (disk) | Yes |
| Memory facts | `data/memory.json` (disk) | Yes |
| Sessions | `data/sessions.json` (disk) | Yes |
| Heartbeat notified events | In-memory Set | No |
| Log buffer | In-memory circular array (200 entries) | No |
| Persona files | Disk (`persona/` directory) | Yes |

---

## Discord Activity System

**Files:** [activity/index.html](activity/index.html), [activity/test.html](activity/test.html), [src/web.ts](src/web.ts) (activity routes)

### Overview

Discord Activities are interactive web apps that run inside Discord voice channels via an iframe. Aelora can host a Unity WebGL build (or any web app) as an Activity.

### Architecture

```
Discord voice channel
  └→ Activity iframe loads https://your-app/.proxy/
       └→ Express serves activity/index.html (with injected clientId)
            ├→ Discord SDK init (DiscordSDK from esm.sh CDN)
            ├→ OAuth2: authorize() → POST /.proxy/api/activity/token → authenticate()
            ├→ Unity WebGL loader (Build/*.gz files via /.proxy/activity/)
            └→ window.discordBridge (Unity ↔ JavaScript interop)
```

All requests from the Activity iframe go through Discord's `/.proxy/` prefix, which maps to the server URL configured in the Developer Portal's URL Mappings.

### Server-Side Components

**Root handler** (`GET /`): When Activity is enabled, serves `activity/index.html` with server-side template injection. Replaces `<!-- __ACTIVITY_CONFIG__ -->` with a `<script>` tag containing `window.__ACTIVITY_CONFIG__ = { clientId, serverUrl }`.

**Static file serving** (`/activity/*`): Serves Unity build files with:
- CORS headers (`Access-Control-Allow-Origin: *`)
- Gzip `Content-Encoding` for `.wasm.gz`, `.js.gz`, `.data.gz` files
- Appropriate `Content-Type` headers

**Token exchange** (`POST /api/activity/token`): Receives an OAuth2 authorization code from the client, exchanges it with Discord's API using the client secret, and returns the access token.

### Client-Side (activity/index.html)

1. **Discord SDK**: Imported from `https://esm.sh/@discord/embedded-app-sdk@2` (no npm install needed)
2. **Config injection**: Reads `window.__ACTIVITY_CONFIG__` (set by server), falls back to fetching `/.proxy/api/activity/config`
3. **OAuth2 flow**: `sdk.commands.authorize()` → token exchange via backend → `sdk.commands.authenticate()`
4. **Unity loader**: Dynamically loads `Builds.loader.js`, then calls `createUnityInstance()` with gzip-compressed build files
5. **Discord bridge**: Exposes `window.discordBridge` with `getUser()` and `getContext()` for Unity C# interop
6. **Ready notification**: Sends `OnDiscordReady` to Unity's `DiscordManager` game object once both SDK and Unity are initialized

### Test Page (activity/test.html)

A standalone page that loads Unity without the Discord SDK — uses stub user data instead. Accessible from the dashboard's "Activity Preview" panel or directly at `/activity/test.html`.

### Unity Build Files

Build files go in `activity/Build/`. The server expects gzip-compressed versions for large files:

| File | Purpose |
|------|---------|
| `Builds.loader.js` | Unity loader script (~39KB, not compressed) |
| `Builds.data.gz` | Game data (gzip compressed) |
| `Builds.framework.js.gz` | Unity framework (gzip compressed) |
| `Builds.wasm.gz` | WebAssembly binary (gzip compressed) |

Compress with `gzip -k -9 Builds.data Builds.framework.js Builds.wasm` after each Unity build.

### Entry Point Command

Discord auto-creates an Entry Point command for applications with Activities enabled. The bot's command registration in [src/discord/client.ts](src/discord/client.ts) preserves these by fetching existing commands, filtering non-slash commands (`type !== 1`), and including them in the bulk `commands.set()` call.

---

## Extension Guide

### Adding a Tool

1. Create `src/tools/my-tool.ts`
2. Use `defineTool()` with typed params and a handler
3. If it needs config, add keys to `config: [...]` and matching entries in `settings.yaml` under `tools:`
4. Restart the bot — it auto-loads
5. Verify in console: `Tools: loaded "my-tool" (enabled)`

#### Quick Example

```typescript
import { defineTool, param } from "./types.js";

export default defineTool({
  name: "hello",
  description: "Greet a user by name.",

  params: {
    name: param.string("The name to greet.", { required: true }),
    enthusiasm: param.enum("How enthusiastic.", ["low", "medium", "high"] as const),
  },

  handler: async ({ name, enthusiasm }) => {
    const suffix = enthusiasm === "high" ? "!!!" : enthusiasm === "low" ? "." : "!";
    return `Hello, ${name}${suffix}`;
  },
});
```

For multi-action tools (the most common pattern), copy `src/tools/_example-multi-action.ts` as your starting point. For API-integrated tools, see `src/tools/_example-gmail.ts`.

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

1. Create a `.md` file inside the target persona's directory (e.g. `persona/aelora/my-file.md`)
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

Create via the REST API (`POST /api/cron`), the web dashboard, or ask the bot to create one using the `cron` tool. Jobs persist to `data/cron-jobs.json` and survive restarts.

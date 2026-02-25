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
                     │  todo · brave-search · cron · │
                     │  memory · mood                │
                     └──────┬───────────────┬────────┘
                            │               │
          ┌─────────────────▼──┐   ┌────────▼───────────────┐
          │  Persistence layer │   │  Radicale CalDAV Server │
          │  memory · sessions │   │  Events (VEVENT)        │
          │  users · mood ·    │   │  Todos (VTODO)          │
          │  daily-log · notes │   │  http://127.0.0.1:5232  │
          │  data/*.json       │   └────────────────────────┘
          └────────────────────┘

  ┌────────────┐    ┌────────────┐    ┌─────────────────────┐
  │  cron.ts   │    │ heartbeat  │    │       web.ts        │
  │  Scheduled │    │  Periodic  │    │  REST API + SSE     │
  │  messages  │    │  handlers  │    │  Dashboard + Activity│
  └──────┬─────┘    └─────┬──────┘    └──────┬──────────────┘
         │                │                  │
         └───── sendToChannel / getLLMOneShot ┘
                                             │
                                    ┌────────▼───────────┐
                                    │       ws.ts        │
                                    │  WebSocket server  │
                                    │  Real-time chat    │
                                    └────────────────────┘

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
| 2 | Load config from `settings.yaml`, set `process.env.TZ` | `config.ts` |
| 3 | Load persona files → compose system prompt | `persona.ts` |
| 4 | Initialize LLM client | `llm.ts` |
| 5 | Auto-discover and load tools | `tool-registry.ts` |
| 6 | Auto-discover and load agents | `agent-registry.ts` |
| 7 | Connect to Discord, register slash commands | `discord/client.ts` |
| 8 | Start cron scheduler | `cron.ts` |
| 9 | Register heartbeat handlers (calendar, memory), start ticker | `heartbeat.ts` |
| 10 | Start web dashboard + WebSocket, set system state provider | `web.ts`, `ws.ts`, `llm.ts` |

Graceful shutdown on SIGINT/SIGTERM: stops heartbeat, stops cron, exits. Uncaught exceptions and unhandled rejections are logged but keep the process alive.

Persona loading is wrapped in try-catch — if the active persona fails to load, the bot continues with the fallback `llm.systemPrompt` from config.

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

`buildSystemPrompt(userId?, channelId?)` assembles the prompt fresh on every request. Sections are ordered **static-first, dynamic-last** to maximize OpenAI's automatic prefix caching — if the first N tokens are identical between requests, they get a cache hit (faster, cheaper):

```
1. [Persona composed prompt]          ← static (changes on persona switch)

2. ## Currently Available              ← static (changes on tool toggle)
   ### Tools / ### Agents

3. ## Current Mood                     ← semi-static (changes on mood shift)
   You are currently feeling **serenity**

4. ## Memory                           ← semi-static (changes on fact save)
   ### About this user / channel

5. ## Conversation Summary             ← dynamic (changes after compaction)

6. ## System Status                    ← most dynamic (uptime changes every request, goes LAST)
   Bot, Discord, Model, Uptime, Heartbeat, Cron
```

In **lite mode** (`llm.lite: true`), the Tool/Agent Inventory and System Status sections are skipped entirely to reduce token count.

The memory section is conditionally injected by `getMemoryForPrompt(userId, channelId)` — only appears when relevant facts exist.

### Tool Calling Loop

`runCompletionLoop()` — up to `MAX_TOOL_ITERATIONS` (10) rounds:

1. Call `client.chat.completions.create()` with messages + tool definitions
2. If response has `tool_calls`: parse args, dispatch each to tool or agent, push results, loop
3. If response is text: return as final answer
4. Safety cap: returns error message if loop exceeds max iterations

### One-Shot Mode

`getLLMOneShot(prompt)` — stateless call with full tool support. Used by:
- Cron jobs (`type: "llm"`)
- Agent sub-loops

### Direct Client Access

`getLLMClient()` and `getLLMModel()` expose the initialized OpenAI client and model name for lightweight direct calls that don't need the full system prompt or tool support (e.g. mood classification).

### Lite Mode

When `config.llm.lite` is `true`:
- `slimDefinitions()` truncates tool descriptions to the first sentence and trims parameter descriptions
- System Status and Tool/Agent Inventory sections are skipped from the system prompt
- Tools remain fully functional — just less verbose in the schema presented to the LLM

Useful for local models (4B–7B) running via LM Studio, Ollama, etc. where token budgets are tight.

### Conversation Compaction

Messages trimmed from history are queued per-channel for async summarization:

1. When history exceeds `maxHistory`, oldest messages are pushed to a compaction queue
2. `compactPendingHistory(minQueueSize)` is called by the memory heartbeat handler
3. When a channel has ≥10 queued messages, they're summarized via a one-shot LLM call
4. Summaries are persisted to `data/memory/summaries.json` (max 3000 chars per channel)
5. Summaries are injected into the system prompt, giving the LLM awareness of earlier conversation context

### External Chat API

`POST /api/chat` and `POST /api/chat/stream` provide the same full conversation experience as Discord — stateful history, user memory, session tracking, mood classification, and daily logs. External apps supply a `sessionId` (maps to internal `channelId`) and optionally `userId`/`username` for identity. `DELETE /api/chat/:sessionId` clears conversation history. Rate-limited to 60 req/min (same as LLM test endpoints).

### WebSocket Chat

**File:** [src/ws.ts](src/ws.ts)

A WebSocket server attached to the same HTTP server on `/ws`. Provides bidirectional real-time chat — ideal for Unity or other game clients where SSE isn't natively supported.

**Connection flow:**

1. Client connects to `ws://host:port/ws` (or `ws://host:port/ws?token=API_KEY` if auth is enabled)
2. Client sends `init` with `sessionId` and optionally `userId`/`username`
3. Server responds with `ready`
4. Client sends `message` → server streams `token` frames, then `done`
5. Live events (mood changes, etc.) pushed as `event` frames automatically

**Protocol (JSON over WebSocket):**

| Direction | Type | Fields |
|-----------|------|--------|
| Client → Server | `init` | `sessionId` (required), `userId?`, `username?` |
| Client → Server | `message` | `content` (required) |
| Client → Server | `clear` | — |
| Server → Client | `ready` | `sessionId` |
| Server → Client | `token` | `content` (streamed chunk) |
| Server → Client | `done` | `reply` (full response) |
| Server → Client | `error` | `error` (message) |
| Server → Client | `event` | `event` (name), `data` (payload) |

Each message runs the same pipeline as the REST chat: `recordMessage()` → `updateUser()` → `getLLMResponse()` with token streaming → `appendLog()` + `classifyMood()`.

Connection management: ping/pong heartbeat every 30s, automatic cleanup on disconnect.

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

1. `loadPersona(dir, variables, activePersona)` discovers all `.md` files under the active persona's directory (e.g. `persona/aelora/`) and the shared `persona/_shared/` directory
2. Shared files are loaded first, then persona-specific files. If a persona has a file with the same basename as a shared file, the persona's version **overrides** the shared one
3. Each file's YAML frontmatter is parsed for metadata:
   - `order` (number) — sort priority (lower = earlier in prompt)
   - `enabled` (boolean) — whether to include in composed prompt
   - `label` (string) — display name for dashboard
   - `section` (string) — grouping category
   - `botName` (string) — character name (used in soul.md to define the character's identity)
4. Files are sorted by `order`, then alphabetically within the same order
5. Enabled files are concatenated with `\n\n` separators
6. `botName` is resolved from the active persona's `soul.md` frontmatter, falling back to `persona.botName` in config
7. Template variables (e.g. `{{botName}}`) are substituted with the resolved character name

### Shared + Per-Persona Architecture

```
persona/
├── _shared/
│   └── bootstrap.md            — Response format rules, operating instructions (order 5)
│                                  Shared by all personas unless overridden
├── aelora/
│   ├── soul.md                 — Behavioral core, identity, personality (order 10, botName: "Aelora")
│   ├── skills.md               — Character skills & competencies (order 50)
│   ├── tools.md                — Tool/agent usage instructions (order 80)
│   └── templates/user.md       — Per-user preferences (disabled, placeholder)
├── wendy/
│   ├── soul.md                 — Gen Z friend who has her life together (order 10, botName: "Wendy")
│   ├── skills.md
│   ├── tools.md
│   └── templates/user.md
├── arlo/
│   ├── soul.md                 — Stoic-strategic advisor (order 10, botName: "Arlo")
│   ├── skills.md
│   ├── tools.md
│   └── templates/user.md
└── batperson/
    ├── bootstrap.md            — Overrides _shared/bootstrap.md (custom format for BatPerson)
    ├── soul.md                 — Absurdist hero (order 10, botName: "BatPerson")
    └── skills.md
```

Each persona's `soul.md` follows the SOUL Authoring Blueprint — a 10-section behavioral contract covering identity, decision biases, cognitive lens, tone constraints, caring protocol, stress matrix, refusal architecture, compression rules, multi-agent alignment, and drift indicators.

### Hot Reload

`POST /api/persona/reload` re-reads all files from disk and updates the live system prompt. No restart needed. Available from the web dashboard.

### Persona Switching

`POST /api/persona/switch` with `{ "persona": "wendy" }`. The switch endpoint loads the new persona before updating config — if loading fails, the previous persona is preserved and an error is returned. Switchable from the dashboard's persona card grid.

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
  requiredFields: ["priority"],
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
| `mood` | Manual emotional state override (set_mood) | none |
| `todo` | Task management via CalDAV VTODO (add/list/complete/update/delete) | `caldav.*` |
| `gmail` | Gmail: search, read, send, reply, forward, labels, drafts | `google.*` |
| `google_calendar` | Google Calendar: list, create, update, delete events | `google.*` |
| `google_docs` | Google Docs: search, read, create, edit documents | `google.*` |
| `google_tasks` | Google Tasks: list, add, complete, update, delete tasks | `google.*` |

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

### Current Agents

| Agent | Description | Tools |
|-------|-------------|-------|
| `researcher` | Multi-step web research with synthesis and optional note saving | `web_search`, `notes` |

---

## Heartbeat System

**Files:** [src/heartbeat.ts](src/heartbeat.ts), [src/heartbeat-calendar.ts](src/heartbeat-calendar.ts), [src/heartbeat-memory.ts](src/heartbeat-memory.ts)

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

### Built-in Handlers

**Calendar Reminder** (`heartbeat-calendar.ts`):
- Every tick: connects to CalDAV, fetches events starting within 15 minutes
- Sends a formatted reminder to the guild's first text channel
- Tracks notified events by UID to avoid duplicates
- Silently skips if CalDAV is not configured

**Memory Compaction** (`heartbeat-memory.ts`):
- Periodically compacts memory facts for efficiency
- Runs on the heartbeat tick cycle

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

## CalDAV Server (Radicale)

**External dependency** — required for the `calendar` and `todo` tools.

Aelora uses a [Radicale](https://radicale.org/) CalDAV server for calendar events (VEVENT) and tasks/todos (VTODO). Radicale is a lightweight Python CalDAV server that runs locally.

### Setup

```bash
# Install
pip install radicale passlib bcrypt

# Generate htpasswd file (run from project root)
python -c "from passlib.hash import bcrypt; print('aelora:' + bcrypt.hash('aelora123'))" > radicale-users

# Start with config
python -m radicale --config radicale-config
```

### Configuration Files

| File | Purpose |
|------|---------|
| `radicale-config` | Server config: host, auth, storage path, permissions |
| `radicale-users` | Htpasswd file (bcrypt-hashed credentials) |
| `data/radicale/` | Calendar/todo data storage (auto-created) |

### Config (`radicale-config`)

```ini
[server]
hosts = 0.0.0.0:5232

[auth]
type = htpasswd
htpasswd_filename = radicale-users
htpasswd_encryption = bcrypt

[storage]
filesystem_folder = data/radicale

[rights]
type = owner_only
```

### Connection

Aelora connects via the `tsdav` npm library. Both the `calendar` and `todo` tools share the same CalDAV client and config:

```yaml
# settings.yaml
tools:
  caldav:
    serverUrl: "http://127.0.0.1:5232"
    username: "aelora"
    password: "aelora123"
    authMethod: "Basic"
    calendarName: "Aelora"
```

The calendar must be created on first setup (Radicale web UI at `http://127.0.0.1:5232` or via MKCALENDAR request).

### Remote Access

For syncing with external CalDAV clients (Thunderbird, DAVx5, iOS), access Radicale via Tailscale's internal network:

- **CalDAV URL:** `http://<tailscale-ip>:5232/aelora/Aelora/`
- Radicale speaks plain HTTP only — Tailscale's WireGuard provides encryption in transit

### What Uses CalDAV

| Component | How |
|-----------|-----|
| `calendar` tool | CRUD for VEVENT objects (list/create/update/delete events) |
| `todo` tool | CRUD for VTODO objects (add/list/complete/update/delete tasks) |
| `heartbeat-calendar.ts` | Polls for upcoming events, sends Discord reminders |
| `web.ts` REST API | `/api/calendar/events` and `/api/todos` endpoints |

---

## Google Workspace Integration

**Files:** [src/tools/_google-auth.ts](src/tools/_google-auth.ts), [src/tools/gmail.ts](src/tools/gmail.ts), [src/tools/google-calendar.ts](src/tools/google-calendar.ts), [src/tools/google-docs.ts](src/tools/google-docs.ts), [src/tools/google-tasks.ts](src/tools/google-tasks.ts)

Four tools provide access to the user's Google Workspace via OAuth2. All share a single set of credentials and a cached access token.

### Authentication

`_google-auth.ts` (underscore = skipped by tool registry) manages OAuth2 refresh-token-to-access-token exchange via `https://oauth2.googleapis.com/token`. The access token is cached module-level with a 60-second pre-expiry buffer. `googleFetch()` wraps `fetch()` with automatic Bearer token attachment. On auth errors, `resetGoogleToken()` clears the cache to force re-auth on the next call.

Config (shared by all three tools):
```yaml
tools:
  google:
    clientId: "..."
    clientSecret: "..."
    refreshToken: "..."
```

### Gmail Tool (`gmail`)

| Action | Description |
|--------|-------------|
| `search` | Search emails with Gmail query syntax |
| `read` | Read full email (headers + decoded body) |
| `send` | Send a new email |
| `reply` | Reply to an email (preserves thread) |
| `forward` | Forward an email to a new recipient |
| `labels` | List all Gmail labels |
| `draft` | Create a draft without sending |

Emails are built as RFC 2822 messages, base64url-encoded, and sent via the Gmail API. Body extraction handles multipart messages (text/plain preferred, HTML fallback with tag stripping).

### Google Calendar Tool (`google_calendar`)

Separate from the CalDAV calendar — this operates on Google Calendar via the REST API.

| Action | Description |
|--------|-------------|
| `list` | List upcoming events (configurable time range) |
| `create` | Create a new event |
| `update` | Update event fields (PATCH) |
| `delete` | Delete an event |
| `calendars` | List available calendars |

Uses the system timezone (`process.env.TZ`) for event times. Default calendar is `primary`.

### Google Docs Tool (`google_docs`)

| Action | Description |
|--------|-------------|
| `search` | Find docs by name via Google Drive API |
| `read` | Read document content (extracted as plain text) |
| `create` | Create a new document (optionally with initial content) |
| `edit` | Insert text at beginning or end of a document |

Document content is extracted by walking the Docs API structural elements (paragraphs → text runs). Editing uses `batchUpdate` with `InsertTextRequest`.

### Google Tasks Tool (`google_tasks`)

| Action | Description |
|--------|-------------|
| `list` | List tasks (configurable count, completed filter) |
| `add` | Add a new task with optional notes and due date |
| `complete` | Mark a task as completed |
| `update` | Update task fields (PATCH) |
| `delete` | Delete a task |
| `lists` | List all task lists |

Uses `tasks.googleapis.com/tasks/v1`. Due dates are date-only (no time support). Tasks sync with Gmail and Google Calendar.

---

## Mood System

**Files:** [src/mood.ts](src/mood.ts), [src/tools/mood.ts](src/tools/mood.ts)

Tracks the bot's emotional state using Plutchik's wheel of emotions — 8 primary emotions at 3 intensity levels (24 distinct states). The mood is auto-classified after each Discord response and displayed live on the dashboard.

### Plutchik's Wheel

| Emotion | Low | Mid | High |
|---------|-----|-----|------|
| Joy | serenity | joy | ecstasy |
| Trust | acceptance | trust | admiration |
| Fear | apprehension | fear | terror |
| Surprise | distraction | surprise | amazement |
| Sadness | pensiveness | sadness | grief |
| Disgust | boredom | disgust | loathing |
| Anger | annoyance | anger | rage |
| Anticipation | interest | anticipation | vigilance |

Blends are supported via an optional `secondary` emotion (e.g. joy + trust = love).

### MoodState

```typescript
type MoodState = {
  emotion: PrimaryEmotion;    // One of 8 primary emotions
  intensity: Intensity;        // "low" | "mid" | "high"
  secondary?: PrimaryEmotion;  // Optional blend
  note?: string;               // Brief context (max 200 chars)
  updatedAt: string;           // ISO timestamp
};
```

Persisted to `data/current-mood.json`. Survives restarts.

### Auto-Classification

After each Discord response, `classifyMood(botResponse, userMessage)` runs asynchronously (fire-and-forget):

1. Checks throttle — skips if mood was updated less than 30 seconds ago
2. Makes a lightweight direct LLM call (no tools, no persona, ~150 token prompt)
3. Parses JSON response into `{ emotion, intensity, secondary?, note? }`
4. Validates against Plutchik's emotions enum
5. Calls `saveMood()` → persists to disk + broadcasts SSE event

The classification uses `getLLMClient()` and `getLLMModel()` from `llm.ts` for a minimal API call — no system prompt, no tools, no history. Just a classifier prompt and the bot's response text.

### Manual Override

The `set_mood` tool allows the bot to express intentional mood shifts that auto-detection might miss. It bypasses the classification throttle. This is a secondary mechanism — auto-classification handles the baseline.

### System Prompt Injection

`buildMoodPromptSection()` adds the current mood to every LLM request:

```
## Current Mood
You are currently feeling **serenity** with undertones of **trust**.
```

When no mood is set yet: `No mood set yet — it will be detected automatically from your responses.`

### Live Dashboard

`saveMood()` calls `broadcastEvent("mood", { ... })` which sends a named SSE event to all connected dashboard clients. The frontend listens for `mood` events on the existing `/api/logs/stream` EventSource and updates the active persona card in-place — colored dot, emotion label, and secondary emotion.

Each of Plutchik's 8 emotions has a mapped color (gold for joy, green for trust, blue for sadness, red for anger, etc.).

---

## User Profiles

**File:** [src/users.ts](src/users.ts)

Tracks a unified profile for every user who messages the bot, aggregated across all channels.

### UserProfile

```typescript
type UserProfile = {
  userId: string;         // Discord user ID
  username: string;       // Latest display name
  firstSeen: string;      // ISO timestamp — first message ever
  lastSeen: string;       // ISO timestamp — most recent message
  messageCount: number;   // Total messages across all channels
  channels: string[];     // Channel IDs the user has been active in
};
```

Persisted to `data/users.json`. Updated on every Discord message via `updateUser()` (called in [src/discord/client.ts](src/discord/client.ts) alongside `recordMessage()`).

### API

- `GET /api/users` — all profiles
- `GET /api/users/:userId` — single profile + memory facts (from `user:{userId}` scope)
- `DELETE /api/users/:userId` — remove profile (does not affect memory facts or sessions)

### Difference from Sessions

Sessions ([src/sessions.ts](src/sessions.ts)) track per-channel stats — a user appears in each channel's `users` record independently. User profiles aggregate across channels into a single record per user.

---

## Cron System

**File:** [src/cron.ts](src/cron.ts)

Schedules jobs using `data/cron-jobs.json` as the single source of truth. Jobs are created via the `cron` tool, REST API, or web dashboard. Uses the `croner` library (cron expressions with timezone support).

### Architecture

The cron system uses a **file-based** architecture to prevent data loss:

- **Every read** loads from `data/cron-jobs.json`
- **Every write** saves atomically (write to temp file, then rename)
- **Only in-memory state** is a `Map<string, SchedulerEntry>` for live `Cron` timer instances — this is scheduling machinery only, never used as a data source
- After any write, `syncSchedulers()` reconciles live timers with the file contents

This design eliminates issues with ESM module duplication where multiple module instances could hold competing in-memory state.

### Job Types

| Type | Behavior |
|------|----------|
| `static` | Sends `job.message` literally to the configured channel |
| `llm` | Sends `job.prompt` to `getLLMOneShot()`, posts the LLM's response |

LLM-type jobs have full tool support — the LLM can call tools while generating the response.

### Timezone Handling

Jobs use the global `timezone` from `settings.yaml` by default (set via `process.env.TZ` at startup). Individual jobs can override with a per-job `timezone` field.

### Job Management

Jobs can be created, updated, toggled, triggered, and deleted through:
- The `cron` tool (LLM-accessible, used during conversations)
- REST API (`POST/PUT/DELETE /api/cron/...`)
- Web dashboard UI

Jobs persist to `data/cron-jobs.json` and are restored on restart. Each job maintains up to 10 execution history records with timestamps, duration, output preview, and error status.

### Execution Flow

1. Cron timer fires → `executeJob(name)`
2. Load job from file by name (gets latest prompt/message)
3. Resolve payload (static message or LLM call)
4. Send to Discord channel
5. Re-load file (in case changes happened during async LLM call)
6. Append history record, cap at 10 entries
7. Save atomically

---

## Discord Integration

**Directory:** [src/discord/](src/discord/)

### client.ts

- Creates a `Client` with intents: Guilds, GuildMessages, MessageContent, DirectMessages
- On ready: sets bot status, registers slash commands (guild-scoped if `guildId` set, otherwise global)
- Preserves Discord-managed commands (e.g. Activity Entry Point) during bulk registration by fetching existing non-slash commands and including them in the update
- Message routing filters: ignores bots, respects `allowedChannels`, `guildMode`, `allowDMs`
- After each response, `classifyMood()` is called fire-and-forget to auto-detect the bot's emotional tone from the response text
- Exports `discordClient`, `botUserId`, `startDiscord()`, `sendToChannel()`

### commands.ts

Seven slash commands, registered on startup:

| Command | Description |
|---------|-------------|
| `/ask [prompt]` | Ask the bot with a rich embed response |
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

### API Documentation

The full API spec is an [OpenAPI 3.1](openapi.yaml) document served with interactive Swagger UI at `/api/docs` when the bot is running. The spec file lives at the project root (`openapi.yaml`).

**Auth:** Optional bearer token via `web.apiKey` in `settings.yaml`. When set, all `/api/*` routes (except `/api/status`, `/api/activity/*`, and `/api/docs`) require `Authorization: Bearer <key>`. SSE endpoints accept `?token=<key>` instead. No key configured = no auth.

**Rate limits:** 1000 req/15 min general, 60 req/min on chat endpoints.

**Route groups:** Status, Config, Persona (10 routes), Chat (3), Cron (6), Sessions (4), Memory (6), Notes (5), Calendar (1), Todos (5), Users (3), Tools (2), Agents (2), System (5 — includes mood), Activity (2) — 57 endpoints total.

### Routing

When `activity.enabled` is true:
- `/` serves `activity/index.html` with injected config (clientId, serverUrl) — this is what Discord's Activity iframe loads
- `/dashboard` serves the web dashboard (`public/index.html`)
- `/activity/*` serves Unity build files with CORS headers and gzip `Content-Encoding` for `.gz` files

When `activity.enabled` is false:
- `/` serves the web dashboard normally

### Frontend

Single-page vanilla JS app in `public/`. Dark design (#0c0c0e), Roboto font, purple accent (#a78bfa). Collapsible panels for each section. Live console via SSE `EventSource`. All controls (toggle, reload, reboot, LLM test) hit the REST API. The active persona card shows a **live mood indicator** (colored dot + emotion label) that updates via named SSE events — no page refresh needed. Includes an **Activity Preview** panel that loads the Unity WebGL test page in an iframe (uses stub Discord data).

---

## Config System

**File:** [src/config.ts](src/config.ts)

`loadConfig()` reads `settings.yaml`, validates it with **Zod schemas** (`configSchema.safeParse()`), and returns a typed `Config` object with defaults applied. Invalid config produces clear error messages listing each validation failure. The `Config` type is derived from the Zod schema via `z.infer<typeof configSchema>`, so types and validation are always in sync. The `timezone` field sets `process.env.TZ` at startup, affecting all date/time operations globally.

### Config Type

```typescript
type Config = {
  timezone: string;            // IANA timezone, default: "UTC"
  discord: {
    token: string;
    guildMode: "mention" | "all";
    allowedChannels: string[];
    allowDMs: boolean;
    status: string;
    guildId?: string;
    embedColor?: number;       // Validated hex, NaN-safe
    statusChannelId?: string;  // Channel for crash/restart notifications
  };
  llm: {
    baseURL: string;
    apiKey: string;
    model: string;
    systemPrompt: string;     // Overwritten by persona system at startup
    maxTokens: number;        // Default: 1024
    maxHistory: number;       // Default: 20
    lite: boolean;            // Default: false — slim tool schemas for local models
  };
  web: { enabled: boolean; port: number; apiKey?: string };
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

`broadcastEvent(event, data)` sends **named** events to all connected SSE and WebSocket clients. Used by the mood system to push live updates — the dashboard listens for `event: mood` on the same `/api/logs/stream` EventSource, and WebSocket clients receive `{ type: "event", event, data }` frames.

### daily-log.ts — Activity Logging

Automatic daily activity logging, persisted to disk. Uses the configured timezone for date formatting.

### utils.ts — Shared Utilities

`chunkMessage(text, maxLength = 2000)` — splits text into Discord-safe chunks, respecting newline boundaries where possible.

### Process Error Handlers

`index.ts` registers handlers for `uncaughtException` and `unhandledRejection` that log the error but keep the process alive, preventing silent crashes from unhandled async errors.

---

## State & Persistence

| Data | Storage | Survives restart? |
|------|---------|-------------------|
| Conversation history | In-memory Map (per channel) | No |
| Notes | `data/notes.json` (disk) | Yes |
| Calendar events | External CalDAV server | Yes |
| Tool/agent enabled state | In-memory registry | No (resets to code defaults) |
| Cron jobs + execution history | `data/cron-jobs.json` (disk, atomic writes) | Yes |
| Memory facts | `data/memory.json` (disk) | Yes |
| Sessions | `data/sessions.json` (disk) | Yes |
| Daily log | `data/daily-log/` (disk) | Yes |
| Mood state | `data/current-mood.json` (disk) | Yes |
| Conversation summaries | `data/memory/summaries.json` (disk) | Yes |
| Active persona | `data/bot-state.json` (disk) | Yes |
| User profiles | `data/users.json` (disk) | Yes |
| Todos | CalDAV server (VTODO) | Yes |
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
3. This creates a self-contained persona directory with template files: `soul.md`, `skills.md`, `tools.md`
4. Bootstrap rules are inherited from `_shared/bootstrap.md` — no per-persona bootstrap needed (unless overriding)
5. Edit the generated `soul.md` to define the character's behavioral core using the SOUL Authoring Blueprint
6. Switch to the new character from the dashboard card grid or via `POST /api/persona/switch`
7. The `{{botName}}` variable resolves to this character's name automatically

### Adding a Cron Job

Create via the REST API (`POST /api/cron`), the web dashboard, or ask the bot to create one using the `cron` tool. Jobs persist to `data/cron-jobs.json` and survive restarts.

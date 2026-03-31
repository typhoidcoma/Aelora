# Architecture

Technical reference for the Aelora 🦋 bot. Covers every system, how they connect, and how to extend them.

## System Overview

```
  ╔══════════════════════════════════════════════════════════════════════╗
  ║                         ENTRY POINTS                               ║
  ╚══════════════════════════════════════════════════════════════════════╝

  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐
  │  Discord API │  │ Web Dashboard│  │  WebSocket   │  │    Cron /   │
  │              │  │  (REST API)  │  │   /ws chat   │  │  Heartbeat  │
  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘
         │                 │                 │                 │
  ┌──────▼───────┐         │                 │                 │
  │ discord/     │         │                 │          scheduled tasks,
  │ client.ts    │         │                 │          periodic handlers
  │ routing,     │         │                 │          (calendar, memory
  │ slash cmds,  │         │                 │           compaction,
  │ attachments  │         │                 │           data cleanup)
  └──────┬───────┘         │                 │                 │
         │                 │                 │                 │
         └─────────────────┴────────┬────────┴─────────────────┘
                                    │
  ╔═════════════════════════════════▼══════════════════════════════════╗
  ║                          LLM CORE (llm.ts)                        ║
  ║                                                                    ║
  ║  ┌───────────────┐   ┌──────────────────┐   ┌──────────────────┐  ║
  ║  │ Persona System│   │  Conversation    │   │   Completion     │  ║
  ║  │ persona.ts    │──▶│  History         │──▶│   Loop           │  ║
  ║  │ compose system│   │  (per-channel)   │   │   streaming,     │  ║
  ║  │ prompt from   │   │                  │   │   tool dispatch,  │  ║
  ║  │ markdown files│   │                  │   │   agent dispatch  │  ║
  ║  └───────────────┘   └──────────────────┘   └────────┬─────────┘  ║
  ╚══════════════════════════════════════════════╤════════╪════════════╝
                                                 │        │
                          ┌──────────────────────▼──┐     │
                          │  LLM API Provider       │     │
                          │  (OpenAI, Ollama,       │     │
                          │   OpenRouter, Groq,     │     │
                          │   LM Studio, etc.)      │     │
                          └─────────────────────────┘     │
                                                          │
                    ┌─────────────────────────────────────┘
                    │
         ┌──────────▼──────────┐    ┌──────────────────────┐
         │   tool-registry.ts  │    │  agent-registry.ts   │
         │   auto-discover     │◀───│  agents get their    │
         │   src/tools/        │    │  own LLM sub-loop    │
         └──────────┬──────────┘    │  with tool allowlist │
                    │               └──────────────────────┘
                    │
  ╔═════════════════▼══════════════════════════════════════════════════╗
  ║                          TOOLS                                     ║
  ║                                                                    ║
  ║  Built-in               Google Suite            Scoring            ║
  ║  ─────────              ────────────            ───────            ║
  ║  notes · memory         gmail                   scoring.ts         ║
  ║  mood · cron            google-calendar         stats · leaderboard║
  ║  ping                   google-tasks            achievements       ║
  ║  discord_history        google-docs             rate_effort        ║
  ║                         tasks (adapter)         set_metadata       ║
  ║                                                 add_event          ║
  ╚════════╤════════════════════╤════════════════════════╤═════════════╝
           │                    │                        │
  ╔════════▼════════╗  ┌────────▼─────────┐   ┌─────────▼──────────────┐
  ║   File Storage  ║  │   Google APIs    │   │  Supabase (PostgreSQL) │
  ║   data/*.json   ║  │   (OAuth2)       │   │  user_profiles         │
  ║                 ║  │                  │   │  life_events           │
  ║  memory.json    ║  └──────────────────┘   │  scoring_events        │
  ║  sessions.json  ║                         │  category_stats        │
  ║  users.json     ║  ┌──────────────────┐   │  achievements          │
  ║  notes.json     ║  │   Web Search     │   └────────────────────────┘
  ║  cron-jobs.json ║  │   API            │
  ║  mood.json      ║  └──────────────────┘
  ║  toggle-state   ║
  ╚═════════════════╝

  ╔══════════════════════════════════════════════════════════════════════╗
  ║                    SIDE SYSTEMS                                     ║
  ║                                                                    ║
  ║  sessions.ts ─── conversation tracking     mood.ts ─── emotion     ║
  ║  users.ts ────── profile tracking          classification          ║
  ║  daily-log.ts ── activity logging          (auto after each reply) ║
  ║  logger.ts ───── console capture + SSE broadcast + file logging    ║
  ║  scoring.ts ──── pure 0-100 scoring engine (no I/O)               ║
  ║  supabase.ts ─── Supabase client singleton + typed helpers         ║
  ║                                                                    ║
  ║  Discord Activity (optional) ── Unity WebGL in Discord iframe      ║
  ║  activity/index.html → SDK + OAuth2 + bridge API                   ║
  ╚══════════════════════════════════════════════════════════════════════╝
```

## Startup Sequence

Defined in [src/index.ts](src/index.ts). Runs in order:

| Step | What | Module |
|------|------|--------|
| 1 | Install logger (patch console) | `logger.ts` |
| 2 | Load config from `settings.yaml`, set `process.env.TZ` | `config.ts` |
| 3 | Load persona files → compose system prompt | `persona.ts` |
| 4 | Initialize LLM client | `llm.ts` |
| 4b | Connect Supabase client (if configured) | `supabase.ts` |
| 5 | Auto-discover and load tools | `tool-registry.ts` |
| 6 | Auto-discover and load agents | `agent-registry.ts` |
| 7 | Connect to Discord, register slash commands | `discord/client.ts` |
| 8 | Start cron scheduler | `cron.ts` |
| 9 | Register heartbeat handlers (calendar, memory, cleanup, reply-check, last-alive, conversation-save, scoring-sync), start ticker | `heartbeat.ts` |
| 10 | Start web dashboard + WebSocket, set system state provider | `web.ts`, `ws.ts`, `llm.ts` |

Graceful shutdown on SIGINT/SIGTERM: saves conversations, saves state, stops heartbeat, stops cron, exits. Uncaught exceptions and unhandled rejections are logged, conversations and state are saved, then the process exits with code 1.

Persona loading is wrapped in try-catch -if the active persona fails to load, the bot continues with the fallback `llm.systemPrompt` from config.

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
   - buildSystemPrompt(userId, channelId) -persona base + system status + tool/agent inventory + memory
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
   /new              → clearSession(channelId) + deleteSession(channelId) → buildSuccessEmbed()
   /websearch [query]→ executeTool("web_search") → buildResponseEmbed()
   /reboot           → reply embed → setTimeout(500ms) → reboot()
   /play             → embed + Link button → discord.com/activities/{appId}
```

Chat messages respond with **streaming plain text**. Slash commands respond with **rich embeds**.

---

## LLM System

**File:** [src/llm.ts](src/llm.ts)

### Client

Uses the `openai` npm package. Any OpenAI-compatible endpoint works -configured via `llm.baseURL` and `llm.apiKey` in settings.

### Conversation History

- Stored in a `Map<string, ChatMessage[]>` keyed by Discord channel ID
- Each channel has independent history
- Trimmed to `maxHistory` (default 50) messages after each exchange
- Periodically persisted to `data/memory/conversations.json` by the conversation-save heartbeat handler (every 5 minutes)
- Also saved on graceful shutdown (SIGINT/SIGTERM) and before crash exits

### System Prompt Composition

`buildSystemPrompt(userId?, channelId?, conversationContext?)` assembles the prompt fresh on every request. Sections are ordered **static-first, dynamic-last** to maximize OpenAI's automatic prefix caching -if the first N tokens are identical between requests, they get a cache hit (faster, cheaper):

```
1. [Persona composed prompt]          ← static (changes on persona switch)

2. ## Currently Available              ← static (changes on tool toggle)
   ### Tools / ### Agents

3. ## Current Mood                     ← semi-static (changes on mood shift)
   You are currently feeling **serenity**  -  Calm, content, at ease.

4. ## Memory                           ← semi-static (changes on fact save)
   ### About this user / channel       ← ranked by semantic relevance + recency + access frequency

5. ## Conversation Summary             ← dynamic (changes after compaction)

6. ## System Status                    ← most dynamic (uptime changes every request, goes LAST)
   Bot, Discord, Model, Uptime, Heartbeat, Cron
```

In **lite mode** (`llm.lite: true`), the Tool/Agent Inventory and System Status sections are skipped entirely to reduce token count.

Update: the live implementation in `llm.ts` has evolved beyond the simplified outline above. The current runtime order is:

```
1. Persona composed prompt
2. ## Currently Available
3. ## Current Mood
4. ## Current User
5. ## Current Session
6. ## Memory
7. ## Reference Material
8. ## Recent Conversation Context
9. ## Current Date & Time
```

Two important clarifications:
- There is currently **no live System Status section** in the runtime prompt. That older description is stale.
- In **lite mode**, the runtime currently skips only the Tool/Agent Inventory section. Mood, user, session, memory, KB excerpts, summaries, and current time are still included.

The memory section is conditionally injected by `getMemoryForPrompt(userId, channelId, conversationContext?)`. When the vector store is available and conversation context is provided, facts are selected by semantic relevance to the current conversation and ranked using a weighted blend of semantic score (70%), recency decay (20%), and access frequency boost (10%). Falls back to recency-based selection when vector search is unavailable.

### Tool Calling Loop

`runCompletionLoop()` -up to `config.llm.maxToolIterations` (default 25) rounds:

1. Call `client.chat.completions.create()` with messages + tool definitions
2. If response has `tool_calls`: parse args, dispatch each to tool or agent, push results, loop
3. If response is text: return as final answer
4. Safety cap: returns error message if loop exceeds max iterations

**Tool message format:** Tool results are stored as plain assistant/user messages rather than OpenAI's `tool` role format. The current runtime re-injects tool rounds in a Qwen/LM Studio-compatible shape:
- An `assistant` message containing the model text (if any) plus one or more `<tool_call>` blocks
- A `user` message containing one or more `<tool_response>` blocks

This avoids template errors with models like Qwen3 in LM Studio, whose Jinja chat templates cannot render `tool` role messages reliably. The formatting is implemented in `renderToolRoundMessages()` in `llm.ts`.

If a model's chat template is incompatible with tool *definitions*, the system falls back to retrying without tools and logs a warning.

### Think Block Stripping

Models that use extended thinking (Qwen3, DeepSeek, Grok) may emit `<think>...</think>` or `<reasoning>...</reasoning>` blocks in their output. These are stripped before the response reaches the user:

- **Post-processing** (`stripThinkBlocks()`): Removes complete blocks, unclosed blocks at end of string, orphaned closing tags at start of string, and Grok-style `Thinking Process:` prefixes
- **Streaming** (`ThinkBlockFilter`): Real-time filter that suppresses think/reasoning blocks token-by-token during streaming, maintaining a buffer to handle tags split across chunk boundaries

### One-Shot Mode

`getLLMOneShot(prompt)` -stateless call with full tool support. Used by:
- Cron jobs (`type: "llm"`)
- Dashboard or external one-shot interactions that want the full persona prompt and tool loop

Agent sub-loops do **not** call `getLLMOneShot()`. They use `runAgentLoop()` with the agent's own system prompt, optional tool allowlist, and optional model override.

### Direct Client Access

`getLLMClient()`, `getLLMModel()`, and `getAuxiliaryModel()` expose initialized client/model handles for lightweight direct calls that don't need the full system prompt or tool loop. Background classification/extraction paths generally use `getAuxiliaryModel()`.

### Persona Modes

The codebase currently uses **three distinct persona interaction modes**:

1. **Full persona path**: `getLLMResponse()` and `getLLMOneShot()` use the composed persona prompt as the base system prompt, then append dynamic runtime sections.
2. **Ambient persona path**: the ambient engine uses `ambientSystemPrompt`, a filtered persona prompt composed from voice-relevant sections only (`bootstrap`, `lore`, `soul`). If that filtered prompt is unavailable, it falls back to the full `systemPrompt`.
3. **No-persona auxiliary path**: mood classification, fact extraction, conversation compaction, and personality synthesis use direct lightweight prompts on the auxiliary model with no full persona prompt, no tool loop, and no conversation history.

### Lite Mode

When `config.llm.lite` is `true`:
- `slimDefinitions()` truncates tool descriptions to the first sentence and trims parameter descriptions
- Tool/Agent Inventory is skipped from the system prompt
- Tools remain fully functional -just less verbose in the schema presented to the LLM

Useful for local models (4B–7B) running via LM Studio, Ollama, etc. where token budgets are tight.

### Conversation Compaction

Messages trimmed from history are queued per-channel for async summarization:

1. When history exceeds `maxHistory`, oldest messages are pushed to a compaction queue
2. `compactPendingHistory(minQueueSize)` is called by the memory heartbeat handler
3. When a channel has ≥10 queued messages, they're summarized via a one-shot LLM call
4. Summaries are persisted to `data/memory/summaries.json` (max 3000 chars per channel)
5. Summaries are injected into the system prompt, giving the LLM awareness of earlier conversation context

### External Chat API

`POST /api/chat` and `POST /api/chat/stream` provide the same full conversation experience as Discord -stateful history, user memory, session tracking, mood classification, and daily logs. External apps supply a `sessionId` (maps to internal `channelId`) and optionally `userId`/`username` for identity. `DELETE /api/chat/:sessionId` clears conversation history. Rate-limited to 60 req/min (same as LLM test endpoints).

### WebSocket Chat

**File:** [src/ws.ts](src/ws.ts)

A WebSocket server attached to the same HTTP server on `/ws`. Provides bidirectional real-time chat -ideal for Unity or other game clients where SSE isn't natively supported.

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
| Client → Server | `clear` | -|
| Server → Client | `ready` | `sessionId` |
| Server → Client | `token` | `content` (streamed chunk) |
| Server → Client | `done` | `reply` (full response) |
| Server → Client | `error` | `error` (message) |
| Server → Client | `event` | `event` (name), `data` (payload) |

Each message runs the same pipeline as the REST chat: `recordMessage()` → `updateUser()` → `getLLMResponse()` with token streaming → `appendLog()` + `classifyMood()`.

Connection management: ping/pong heartbeat every 30s, automatic cleanup on disconnect.

### Agent Loop

`runAgentLoop(options)` -sub-completion-loop with:
- Agent's own system prompt (not the persona prompt)
- Tool allowlist: `undefined` = no tools, `["*"]` = all tools, `["a", "b"]` = specific tools
- `allowAgentDispatch = false` -agents cannot call other agents (prevents recursion)
- Optional model override (agents can use a different LLM)

---

## Persona System

**Files:** [src/persona.ts](src/persona.ts), [persona/](persona/)

### How It Works

1. `loadPersona(dir, variables, activePersona)` discovers all `.md` files under the active persona's directory (e.g. `persona/aelora/`) and the shared `persona/_shared/` directory
2. Shared files are loaded first, then persona-specific files. If a persona has a file with the same basename as a shared file, the persona's version **overrides** the shared one
3. Each file's YAML frontmatter is parsed for metadata:
   - `order` (number) -sort priority (lower = earlier in prompt)
   - `enabled` (boolean) -whether to include in composed prompt
   - `label` (string) -display name for dashboard
   - `section` (string) -grouping category
   - `botName` (string) -character name (used in soul.md to define the character's identity)
4. Files are sorted by `order`, then alphabetically within the same order
5. Enabled files are concatenated with `\n\n` separators
6. `botName` is resolved from the active persona's `soul.md` frontmatter, falling back to `persona.botName` in config
7. Template variables (e.g. `{{botName}}`) are substituted with the resolved character name

### Shared + Per-Persona Architecture

```
persona/
├── _shared/
│   ├── bootstrap.md            # Response format rules (order 5, shared by all)
│   └── lore.md                 # Shared Lumie lore and Covenant (order 6)
├── aelora/
│   ├── soul.md                 # Behavioral core (order 10, botName: "Aelora")
│   ├── execution.md            # Execution protocol (order 15)
│   ├── skills.md               # Character skills (order 50)
│   ├── tools.md                # Tool usage instructions (order 80)
│   └── templates/user.md       # Per-user preferences (placeholder)
├── wendy/
│   ├── soul.md                 # Behavioral core (order 10, botName: "Wendy")
│   ├── backstory.md            # Wendy-specific lore anchors (order 12)
│   ├── skills.md               # Character skills (order 50)
│   └── tools.md                # Tool usage instructions (order 80)
├── arlo/                       # soul, skills, tools, templates
├── tyler/                      # soul, skills, tools
└── patyna/
    ├── bootstrap.md            # Overrides _shared/bootstrap.md (ambient presence)
    ├── soul.md
    ├── skills.md
    └── tools.md
```

Each persona's `soul.md` follows the SOUL Authoring Blueprint -a 10-section behavioral contract covering identity, decision biases, cognitive lens, tone constraints, caring protocol, stress matrix, refusal architecture, compression rules, multi-agent alignment, and drift indicators.

### Hot Reload

`POST /api/persona/reload` re-reads all files from disk and updates the live system prompt. No restart needed. Available from the web dashboard.

### Persona Switching

`POST /api/persona/switch` with `{ "persona": "wendy" }`. The switch endpoint loads the new persona before updating config -if loading fails, the previous persona is preserved and an error is returned. Switchable from the dashboard's persona card grid.

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

The recommended way to create tools. Handles JSON Schema generation, argument validation, and config resolution.

Important distinction:
- **Recommended authoring pattern:** use `defineTool()` for new tools
- **Runtime contract:** the registry only requires that a module export a valid `Tool` object with `definition.name`, `handler`, `enabled`, and optional `parameters`. `defineTool()` is the standard helper that produces that shape plus normalized `{ text, data }` behavior.

`defineTool()` additionally enforces two helper-layer contracts before a handler runs:
- argument validation failures return `Error: invalid arguments: ...`
- missing required tool config returns `Error: tool "<name>" missing config: ...`

That matters because `llm.ts` treats `Error:`-prefixed tool text as a failed tool call.

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
    return {
      text: "Human-readable result for the LLM.",
      data: { action: args.action, title: args.title },
    };
  },
});
```

**`param` helpers:** `param.string()`, `param.number()`, `param.boolean()`, `param.enum()`, `param.array()`, `param.object()`, `param.date()` -each returns a `ParamSchema` with JSON Schema metadata and a `_required` flag.

#### `param.object()` - Structured nested data

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

#### `param.date()` - Date/datetime strings

```typescript
dueDate: param.date("When the task is due."),
startDate: param.date("Start date.", { format: "date" }),  // YYYY-MM-DD only
```

Emits a `string` type with a format hint appended to the description. Defaults to ISO 8601 datetime (`format: "date-time"`). Use `format: "date"` for date-only values.

#### `requireContext()` - Context validation helper

Validates that required context fields (like `userId`, `channelId`) are present. Returns `null` on success or an `"Error: ..."` string on failure -designed to be returned directly from a handler.

```typescript
import { defineTool, param, requireContext } from "./types.js";

handler: async (args, ctx) => {
  const err = requireContext(ctx, "userId", "channelId");
  if (err) return err;
  // ctx.userId and ctx.channelId are guaranteed non-null here
}
```

#### Structured Output (ToolResult)

Tool handlers return a `ToolResult`: either a plain string (backward compatible) or a `{ text, data }` object.

```typescript
// Plain string (still works -normalized internally)
return "Pong! Server time: 2025-03-15T10:00:00Z";

// Structured output (preferred for all new tools)
return {
  text: "Pong! Server time: 2025-03-15T10:00:00Z",  // sent to the LLM
  data: { serverTime: "2025-03-15T10:00:00Z" },      // included in REST API response
};
```

**Types** (defined in `src/tools/types.ts`):

```typescript
type ToolResultObject = { text: string; data?: unknown };
type ToolResult = string | ToolResultObject;
```

**How results are consumed:**

| Consumer | Function | Gets |
|---|---|---|
| LLM tool loop (`llm.ts`) | `executeToolText()` | `text` string only |
| REST API (`/api/tools/:name/execute`) | `executeTool()` | `{ success, tool, result, data? }` |

`normalizeToolResult()` converts both forms to `ToolResultObject`. The `data` field is omitted from the REST response when `undefined`. Error returns can stay as plain strings -`normalizeToolResult()` wraps them automatically.

Runtime-required semantics:
- failures should return `Error: ...` text so the LLM loop can recognize the tool call as failed
- successes should return human-readable `text`, even when structured `data` is also present

#### Multi-Action Tool Pattern

Most tools use a single `action` enum param with a `switch` statement. See `src/tools/_example-multi-action.ts` for a complete template.

Recommended conventions:

1. **Action enum**: Always `required: true`, first param
2. **Conditional required params**: Validate inside each `case` branch, not at the param level
3. **Context validation**: Use `requireContext()` at the top of the handler
4. **Error format**: Return `"Error: ..."` strings for actionable failures
5. **Default branch**: Include a `default:` case returning `"Error: unknown action ..."`

Runtime-required semantics:
- do not throw from a handler for expected validation or action-selection errors
- if the tool wants the LLM loop to treat a branch as failure, the returned text must begin with `Error:`

### Config Resolution

Tools declare config dependencies as dotted paths (e.g. `["google.clientId", "google.refreshToken"]`). At runtime, `defineTool()` resolves these from the `tools:` section of `settings.yaml`:

```yaml
tools:
  google:
    clientId: "..."
    clientSecret: "..."
    refreshToken: "..."
```

If required config keys are missing, the tool returns an error message instead of executing.

### Runtime Toggle

Tools can be enabled/disabled at runtime via `POST /api/tools/:name/toggle` or the web dashboard. Enabled state is persisted through `saveToolToggle()` / `loadToggleState()` in `state.ts` and restored on startup.

### REST API Tool Execution

Tools can be called directly via the REST API, bypassing the LLM. Useful for integrations, dashboards, and automated workflows.

**Endpoint:** `POST /api/tools/:name/execute`

**Request:**
```json
{
  "args": { "action": "save", "scope": "global", "fact": "Project deadline is March 30" },
  "channelId": "optional-discord-channel-id",
  "userId": "optional-discord-user-id"
}
```

**Response:**
```json
{
  "success": true,
  "tool": "memory",
  "result": "Remembered (global): \"Project deadline is March 30\"",
  "data": {
    "action": "save",
    "scope": "global",
    "fact": "Project deadline is March 30"
  }
}
```

The `result` field is always a human-readable string. The `data` field contains structured JSON when the tool provides it (omitted on errors).

**Examples:**

```bash
# Ping (test connectivity)
curl -X POST http://localhost:3000/api/tools/ping/execute \
  -H "Content-Type: application/json" \
  -d '{"args": {"message": "hello"}}'

# List Google Tasks
curl -X POST http://localhost:3000/api/tools/google_tasks/execute \
  -H "Content-Type: application/json" \
  -d '{"args": {"action": "list"}}'

# Save a note
curl -X POST http://localhost:3000/api/tools/notes/execute \
  -H "Content-Type: application/json" \
  -d '{"args": {"action": "save", "title": "shopping", "content": "Eggs, milk, bread", "scope": "global"}}'

# Search memory facts and daily logs
curl -X POST http://localhost:3000/api/tools/memory/execute \
  -H "Content-Type: application/json" \
  -d '{"args": {"action": "search", "query": "deadline"}}'
```

**Authentication:** If `web.apiKey` is configured in `settings.yaml`, include `Authorization: Bearer <key>` in all requests.

**Discovery:** `GET /api/tools` lists all tools with their parameter schemas. `GET /api/tools/:name` returns a single tool's details.

### Current Tools

Tool file names and exported tool names are usually aligned, but not always. For example:
- `brave-search.ts` exports the `web_search` tool
- `mood.ts` exports the `set_mood` tool

| Tool | Description | Config |
|------|-------------|--------|
| `ping` | Responds with pong + server time | none |
| `notes` | Persistent note storage (save/get/list/delete) | none |
| `web_search` | Web search (configurable: Brave or OpenAI provider) | `brave.apiKey` or `search.provider` |
| `cron` | Create, list, toggle, trigger, delete cron jobs at runtime | none |
| `memory` | Remember/recall/forget facts about users and channels | none |
| `tasks` | Per-user task list adapter over Google Tasks (list/get/create/complete/update/delete, auto-creates task list per Discord user) | `google.*` |
| `gmail` | Gmail: search, read, send, reply, forward, labels, drafts | `google.*` |
| `calendar` | Per-user personal calendar (list/create/update/delete events, auto-creates calendar per Discord user) | `google.*` |
| `google_calendar` | Admin read-only calendar tool (list events, list calendars) + exports CRUD helpers used by `calendar` | `google.*` |
| `google_docs` | Google Docs: search, read, create, edit documents | `google.*` |
| `google_tasks` | Admin-level raw Google Tasks API (list/add/complete/update/delete on explicit list IDs) — use `tasks` for user-facing task management | `google.*` |
| `discord_history` | Fetch recent message history from Discord text channels | none |
| `scoring` | Scoring tool: stats, leaderboard, achievements, rate_effort, set_metadata, add_event (Supabase) | `google.*` |
| `set_mood` | Manual emotional state override (Plutchik's wheel: 8 emotions × 3 intensities, dyad resolution for adjacent pairs, opposition warnings) | none |
| `date` | Natural language date resolution via chrono-node (converts "next Friday" → ISO 8601) | none |
| `linear` | Full Linear project management: issues CRUD, sub-issues, projects, teams, search, comments, GraphQL | `linear.apiKey` |
| `luminizer` | Image generation and restyling via DALL-E 3 / gpt-image-1 (text-to-image generation, image-to-image restyling, configurable style prompts) | `luminizer.apiKey`, `luminizer.model`, `luminizer.baseURL`, `luminizer.stylePrompt` |

> **Tool Architecture Notes:**
> - `google_calendar` exports CRUD functions (`createEvent`, `updateEvent`, `deleteEvent`, `listEvents`) used by `calendar` and heartbeat handlers. Its own tool registration is read-only (list events, list calendars).
> - `tasks` is the per-user tool (auto-creates task lists, used for all user interactions). `google_tasks` is the admin/raw API tool for debugging and bulk operations on explicit list IDs.

---

## Agent System

**Files:** [src/agent-registry.ts](src/agent-registry.ts), [src/agents/types.ts](src/agents/types.ts)

### How Agents Work

Agents are presented to the LLM as function calls, identical to tools. When the LLM calls an agent:

1. `isAgent(name)` detects it's an agent, not a tool
2. `executeAgent()` calls `runAgentLoop()` -a sub-completion-loop with:
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
| `sprint_planner` | Sprint planning via Linear backlog analysis, capacity review, and prioritized plan with assignments | `linear` |
| `standup` | Team standup report from Linear — completed, in-progress, blocked, and at-risk issues | `linear` |

---

## Heartbeat System

**Files:** [src/heartbeat.ts](src/heartbeat.ts), [src/heartbeat-calendar.ts](src/heartbeat-calendar.ts), [src/heartbeat-memory.ts](src/heartbeat-memory.ts), [src/heartbeat-cleanup.ts](src/heartbeat-cleanup.ts), [src/heartbeat-reply-check.ts](src/heartbeat-reply-check.ts), [src/heartbeat-alive.ts](src/heartbeat-alive.ts), [src/heartbeat-conversations.ts](src/heartbeat-conversations.ts), [src/heartbeat-scoring-sync.ts](src/heartbeat-scoring-sync.ts), [src/heartbeat-consolidation.ts](src/heartbeat-consolidation.ts), [src/heartbeat-knowledge-sync.ts](src/heartbeat-knowledge-sync.ts)

A periodic tick system that runs registered handlers at a configurable interval (default: 15 minutes).

### Handler Interface

```typescript
type HeartbeatHandler = {
  name: string;
  description: string;
  enabled: boolean;
  execute: (ctx: HeartbeatContext) => Promise<string | void>;
};

type HeartbeatContext = {
  sendToChannel: (channelId: string, text: string) => Promise<void>;
  llmOneShot: (prompt: string) => Promise<string>;
  config: Config;
};
```

Handlers receive Discord send capability, LLM access, and full config. They run sequentially on each tick, with errors caught per-handler. If a handler returns a string, it is logged with elapsed time.

### Built-in Handlers

**Calendar Reminder** (`heartbeat-calendar.ts`):
- Every tick: calls Google Calendar API, fetches events starting within 15 minutes
- Sends a formatted reminder to the guild's first text channel
- Tracks notified events by UID in `data/notified-events.json` to avoid duplicates
- Silently skips if Google credentials are not configured

**Memory Compaction** (`heartbeat-memory.ts`):
- Periodically compacts memory facts for efficiency
- Runs on the heartbeat tick cycle

**Data Cleanup** (`heartbeat-cleanup.ts`):
- Runs hourly (skips most ticks via timestamp check)
- Prunes memory facts older than `memory.maxAgeDays` (0 = disabled)
- Archives sessions older than the configured TTL (defaults to 30 days if memory TTL is off)

**Reply Check** (`heartbeat-reply-check.ts`):
- Every 5 minutes: scans last 20 messages in each text channel across all guilds
- Catches missed @mentions and replies-to-bot that the main message listener did not respond to
- Only processes messages younger than 30 minutes that haven't been seen before
- Capped at 3 replies per tick; tracks seen message IDs (pruned to 500 entries)

**Last Alive** (`heartbeat-alive.ts`):
- Every tick: writes the current timestamp to disk via `updateLastAlive()`
- Used for crash/force-kill detection by external monitors or the restart logic
- Silent (returns nothing)

**Conversation Save** (`heartbeat-conversations.ts`):
- Every 5 minutes: persists in-memory conversation history to `data/memory/conversations.json`
- Guards with its own timestamp check independent of the heartbeat tick rate

**Scoring Sync** (`heartbeat-scoring-sync.ts`):
- Every 5 minutes: for each known user profile with a `google_task_list_id`, resolves their per-user task list, fetches pending tasks, and upserts them into Supabase `life_events`
- Runs LLM-powered metadata enrichment on un-enriched tasks (impact level, size label, estimated minutes, category, irreversible, affects others)
- Silently skips if Google credentials or Supabase are not configured
- Returns a summary log string (e.g. `synced 12 task(s) for 2 user(s)`)

**Fact Consolidation** (`heartbeat-consolidation.ts`):
- Tracks new facts added per scope via a callback from `saveFact()`
- When a scope accumulates `consolidationThreshold` (default: 10) new facts, triggers an LLM merge pass
- Groups facts by category; only consolidates categories with 4+ facts
- LLM merges related facts into fewer, richer statements while preserving all specific details
- Deletes consumed facts and saves merged replacements with `source: "consolidation"`
- Updates both the JSON store and vector index
- Processes at most 1 scope per tick to limit API usage
- Configurable via `memory.consolidationEnabled` and `memory.consolidationThreshold`

**Knowledge Base Sync** (`heartbeat-knowledge-sync.ts`):
- Every 30 minutes (configurable): syncs a Google Drive folder to the vector index
- Detects new, updated, and deleted files; re-chunks and re-indexes as needed
- Persists file manifest to `data/kb-manifest.json` for change detection
- Silently skips if knowledge base is disabled or Google credentials are not configured

**Data Cleanup** also prunes orphaned vectors hourly, but skips `kb`-scoped vectors (managed by the sync pipeline).

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

## Google Workspace Integration

**Files:** [src/tools/_google-auth.ts](src/tools/_google-auth.ts), [src/tools/gmail.ts](src/tools/gmail.ts), [src/tools/google-calendar.ts](src/tools/google-calendar.ts), [src/tools/google-docs.ts](src/tools/google-docs.ts), [src/tools/google-tasks.ts](src/tools/google-tasks.ts), [src/tools/tasks.ts](src/tools/tasks.ts)

Five tools provide access to the user's Google Workspace via OAuth2. All share a single set of credentials and a cached access token.

### Authentication

`_google-auth.ts` (underscore = skipped by tool registry) manages OAuth2 refresh-token-to-access-token exchange via `https://oauth2.googleapis.com/token`. The access token is cached module-level with a 60-second pre-expiry buffer. `googleFetch()` wraps `fetch()` with automatic Bearer token attachment. On auth errors, `resetGoogleToken()` clears the cache to force re-auth on the next call.

Config (shared by all four tools):
```yaml
tools:
  google:
    clientId: "..."
    clientSecret: "..."
    refreshToken: "..."
```

### OAuth2 Setup

The refresh token must be obtained externally (no interactive auth flow). Use the [Google OAuth Playground](https://developers.google.com/oauthplayground/):

1. Create a Google Cloud project and enable: Gmail API, Google Calendar API, Google Docs API, Google Tasks API, Google Drive API
2. Create an **OAuth client ID** (Web application) with redirect URI `https://developers.google.com/oauthplayground`
3. In the OAuth Playground, use your own credentials (gear icon > "Use your own OAuth credentials")
4. Authorize these scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/drive.readonly`
5. Exchange the authorization code for tokens and copy the **Refresh Token**

See [README.md > Google Workspace Setup](README.md#google-workspace-setup) for step-by-step instructions.

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

Operates on Google Calendar via the REST API.

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

Document content is extracted by walking the Docs API structural elements (paragraphs → text runs). Read content is truncated at 25,000 characters. Editing uses `batchUpdate` with `InsertTextRequest`.

### Google Tasks Tool (`google_tasks`)

| Action | Description |
|--------|-------------|
| `list` | List tasks (configurable count, completed filter) |
| `add` | Add a new task with optional notes and due date |
| `add_many` | Batch-add multiple tasks from a JSON array (each with title, optional notes and dueDate) |
| `complete` | Mark a task as completed |
| `update` | Update task fields (PATCH) |
| `delete` | Delete a task |
| `lists` | List all task lists |

Uses `tasks.googleapis.com/tasks/v1`. Due dates are date-only (no time support). Tasks sync with Gmail and Google Calendar. The `add_many` action accepts a JSON string array and creates tasks sequentially, returning a summary of successes and failures.

### Tasks Adapter (`tasks`)

`src/tools/tasks.ts` is a higher-level adapter over Google Tasks that exposes a normalized `TaskItem` interface used by the web dashboard and the scoring system. Each Discord user gets their own Google Task list, auto-created on first use.

```typescript
type TaskItem = {
  uid: string;           // Google Task id
  title: string;
  description?: string;  // Google Tasks "notes"
  completed: boolean;
  priority: "low" | "medium" | "high";  // metadata only (Google Tasks has no priority field)
  dueDate?: string;      // ISO 8601 from Google Tasks RFC 3339 "due"
  updatedAt?: string;    // Google Tasks "updated"
};
```

Exported functions: `listTasks`, `getTaskByUid`, `createTask`, `completeTask`, `updateTask`, `deleteTask`, `createTaskList`, `resolveUserTaskList`. All CRUD functions accept a `GoogleConfig` and `taskListId` param. `resolveUserTaskList(config, discordUserId, username?)` checks `user_profiles.google_task_list_id` in Supabase; if null, creates a new Google Task list via the API and stores the mapping.

---

## Knowledge Base (Google Drive)

**Files:** [src/knowledge-base.ts](src/knowledge-base.ts), [src/heartbeat-knowledge-sync.ts](src/heartbeat-knowledge-sync.ts)

The knowledge base syncs a designated Google Drive folder into the Vectra vector index, making shared documents automatically searchable during conversations. It reuses the same vector store, embedding pipeline, and Google OAuth as the memory and Google Workspace systems.

### Sync Pipeline

Runs on a heartbeat handler (default every 30 minutes):

1. **List** — fetch all files in the configured Drive folder via `googleFetch()`
2. **Diff** — compare against `data/kb-manifest.json` (tracks fileId, modifiedTime, chunkCount)
3. **Delete** — remove vectors for files no longer in Drive (`removeItemsByFilter({ source: "drive:{fileId}" })`)
4. **Extract** — pull text based on MIME type:
   - Google Docs → export as `text/plain`
   - PDFs → download binary, extract with `pdf-parse` (PDFParse class)
   - Text/Markdown/CSV/JSON/XML → download directly
   - Google Sheets → export as CSV
   - Images → use file `description` metadata from Drive (skip if empty)
5. **Chunk** — split text on paragraph boundaries, merge up to `chunkSize` chars with `chunkOverlap` overlap. Falls back to sentence splitting for oversized paragraphs. Each chunk gets a `[FileName]` header prepended for embedding context.
6. **Embed & index** — each chunk is indexed via `vectorStore.indexFact()` with:
   - `scope` = `"kb"`
   - `source` = `"drive:{fileId}"` (enables per-file cleanup on re-sync)
   - `category` = `"knowledge"`, `confidence` = `"stated"`
7. **Save manifest** — update `data/kb-manifest.json` with new file metadata

### System Prompt Injection

In `buildSystemPrompt()` (llm.ts), KB search runs in parallel with memory search via `Promise.all`. Results appear as:

```
## Reference Material
The following excerpts from shared documents may be relevant:

**[Document Name]** (excerpt):
> relevant text chunk...
```

Capped at `maxChunksPerPrompt` (default 5) to control token budget.

### Orphan Cleanup

The hourly `pruneOrphanVectors()` in `heartbeat-cleanup.ts` passes `skipScopes: new Set(["kb"])` to avoid deleting KB vectors. KB cleanup is handled by the sync pipeline itself (removing vectors when files are deleted or re-indexed).

### Config

```yaml
knowledge:
  enabled: false
  driveFolderId: ""
  syncIntervalMinutes: 30
  chunkSize: 800
  chunkOverlap: 100
  maxChunksPerPrompt: 5
  minRelevanceScore: 0.35
```

Env override: `AELORA_KB_DRIVE_FOLDER_ID`

---

## Ambient Awareness System

**Files:** [src/ambient/engine.ts](src/ambient/engine.ts), [src/ambient/buffer.ts](src/ambient/buffer.ts), [src/ambient/engagement.ts](src/ambient/engagement.ts), [src/ambient/types.ts](src/ambient/types.ts), [src/ambient/url-extract.ts](src/ambient/url-extract.ts), [src/ambient/triggers/converse.ts](src/ambient/triggers/converse.ts), [src/ambient/triggers/image-react.ts](src/ambient/triggers/image-react.ts)

Passive channel monitoring system that lets the bot participate naturally in Discord conversations without being directly addressed. The engine ingests every message from allowed channels into per-channel ring buffers and periodically evaluates registered triggers to decide whether to speak.

### Architecture

```
Discord MessageCreate
        │
        ▼
  ingestMessage()          ← buffer.ts: push to per-channel ring buffer (FIFO, max bufferSize)
        │
        ▼
  evaluateTick()           ← engine.ts: runs on its own interval (default 5 min)
        │
   ┌────┴────┐
   │ Per-channel, per-trigger evaluation:
   │  1. Global rate limit check (default 6/hour)
   │  2. Channel cooldown check (shared engagement tracker)
   │  3. Trigger-specific cooldown check
   │  4. shouldEvaluate() — cheap pre-filter (no LLM)
   │  5. Random skip (configurable skipChance)
   │  6. evaluate() — full LLM evaluation (auxiliary model)
   │  7. Send message or reply, record cooldowns
   └─────────┘
```

### Buffer System (`buffer.ts`)

Every message in allowed Discord channels is pushed into a per-channel `ChannelBuffer`. Each buffer is a capped ring buffer (`bufferSize`, default 100). Messages are stored as `BufferedMessage` with metadata: author, content, timestamps, attachment types, image URLs, reaction counts, and bot flag.

Key exports: `ingestMessage()`, `getRecentMessages(channelId, windowMs)`, `formatBufferForLLM()`, `formatBufferForLLMMultimodal()`, `getBufferStats()`.

### Engagement Tracker (`engagement.ts`)

Shared rate limiter across all bot response paths (ambient, name-triggered replies, reply-check heartbeat). `recordEngagement(channelId, source)` logs when the bot spoke; `canEngage(channelId, cooldownMs)` checks if the cooldown has expired. Prevents cascading loops where multiple systems try to respond to the same channel simultaneously.

### Triggers

Triggers implement the `AmbientTrigger` interface: a `shouldEvaluate()` pre-filter (cheap, no LLM) and an `evaluate()` method (may call LLM via auxiliary model). Triggers are shuffled each tick to avoid priority bias.

| Trigger | Description | Key Config |
|---------|-------------|------------|
| `converse` | Joins active multi-user conversations when the bot has something genuine to add. Requires N messages from M unique users within a time window. Uses multimodal prompt with URL content extraction. | `minMessages`, `minUsers`, `windowMinutes` |
| `image-react` | Reacts to images that went unacknowledged. Targets images within an age window (min/max minutes) with no reactions and minimal follow-up conversation. Uses vision (multimodal) prompt. | `minAgeMinutes`, `maxAgeMinutes` |

### URL Content Extraction (`url-extract.ts`)

Fetches and extracts readable text from URLs shared in conversations. Used by the `converse` trigger to give the LLM context about shared links. Features: HTML stripping, 30-minute LRU cache, 5-second fetch timeout, max 3 URLs per evaluation, Discord CDN URLs skipped.

### Engine Lifecycle

`registerAmbientEngine(config, sendToChannel)` starts the evaluation timer and registers a heartbeat handler for status reporting. The engine runs independently of the heartbeat interval (default evaluation every 5 minutes vs 15-minute heartbeat). `stopAmbientEngine()` clears the timer. `toggleTrigger(name, enabled)` provides runtime overrides that persist until restart.

Ambient evaluation does **not** use the full persona prompt by default. It uses `ambientSystemPrompt`, which is built at startup from voice-relevant persona sections only (`bootstrap`, `lore`, `soul`) so the ambient model keeps the persona's voice without carrying tools/skills instructions into lightweight group-chat evaluation.

### Rate Limiting

- **Global:** max `globalRateLimitPerHour` sends across all channels (default 6)
- **Per-channel:** shared engagement cooldown (`channelCooldownMinutes`, default 15 min)
- **Per-trigger:** individual cooldown per trigger per channel (`cooldownMinutes`, default 30 min)
- **Random skip:** each evaluation has a `skipChance` probability of being silently skipped (default 25-30%)

### API Endpoints

- `GET /api/ambient/status` — engine state, trigger stats (evaluated/fired/skipped counts, cooldowns), buffer stats
- `GET /api/ambient/buffers` — per-channel buffer stats (message count, oldest/newest timestamps, last ambient send)
- `POST /api/ambient/triggers/:name/toggle` — enable/disable a trigger at runtime (`{ enabled: boolean }`)

### Config

```yaml
ambient:
  enabled: false
  bufferSize: 100
  evaluationIntervalMs: 300000     # 5 minutes
  globalRateLimitPerHour: 6
  channelCooldownMinutes: 15
  minBufferMessages: 3
  triggers:
    converse:
      enabled: true
      cooldownMinutes: 30
      skipChance: 0.3
      minMessages: 4
      minUsers: 2
      windowMinutes: 30
    imageReact:
      enabled: true
      cooldownMinutes: 30
      skipChance: 0.25
      minAgeMinutes: 3
      maxAgeMinutes: 45
```

---

## Linear Integration

**Files:** [src/tools/linear.ts](src/tools/linear.ts)

Full read/write access to Linear project management via the `@linear/sdk`. A single multi-action tool (`linear`) exposes 16 actions:

**Read:** `list_issues`, `get_issue`, `search`, `my_issues`, `list_projects`, `list_teams`, `list_sub_issues`
**Write:** `create_issue`, `create_sub_issue`, `update_issue`, `add_comment`, `delete_issue`
**Projects:** `create_project`, `update_project`, `add_project_update`
**Advanced:** `graphql` (raw GraphQL query for anything not covered above)

Config: `linear.apiKey` in `settings.yaml`. The web dashboard exposes a full set of REST endpoints under `/api/linear/*` (15 routes) mirroring the tool actions.

**Note:** Linear is used for project management only. It does not feed into the scoring pipeline. Scored tasks come exclusively from Google Tasks (per-user lists).

---

## Scoring System

**Files:** [src/scoring.ts](src/scoring.ts), [src/supabase.ts](src/supabase.ts), [src/tools/scoring.ts](src/tools/scoring.ts), [src/heartbeat-scoring-sync.ts](src/heartbeat-scoring-sync.ts)

Fully automatic priority scoring across five life categories. Scores update in the background. Users see results via the Discord scoring tool or web dashboard; they never interact with the pipeline directly.

### Architecture

```
Google Tasks API
      │
      ▼
heartbeat-scoring-sync.ts        (every 5 min)
      │  upsertLifeEvent()
      ▼
Supabase life_events table       (source of truth for scoring metadata)
      │
      ├─ scoring.ts: scoreTask() (pure formula, no I/O)
      │
      ├─ supabase.ts: recordScoringEvent(), updateUserProfile(),
      │               updateCategoryStats(), checkAchievements()
      │
      └─ src/tools/scoring.ts    (LLM tool: stats/leaderboard/achievements/rate_effort/set_metadata/add_event)
```

### Supabase Schema (5 tables)

| Table | Purpose |
|-------|---------|
| `user_profiles` | Per-user XP total, streak, longest streak, last completion date, `google_task_list_id` (per-user task list mapping) |
| `life_events` | All trackable events: tasks, health, finance, social, work. Linked to Google Tasks via `external_uid` |
| `scoring_events` | Immutable scoring history: each completion records all 4 dimension scores, points awarded, streak at time |
| `category_stats` | EMA-based adaptive stats per user per category: avg score, avg hours to complete, avg SMEQ, personal bias |
| `achievements` | Unlocked achievements with timestamp |

RLS is disabled on all five tables (server-side anon key access). The `(discord_user_id, external_uid)` unique constraint on `life_events` prevents duplicate syncs.

### Score Formula

```
Total (0-100) = Urgency (0-35) + Impact (0-30) + Effort (0-20) + Context (0-15)
```

**Urgency (0-35):** Exponential temporal decay based on hyperbolic discounting.
```
Urgency = 35 * e^(-0.013 * hoursUntilDue)
No deadline → 18 (neutral)    Overdue → 35 (max)
```

**Impact (0-30):** Consequence of not completing the task.
```
trivial=5, low=10, moderate=17, high=24, critical=30
+6 if irreversible (capped at 30)
+3 if affects_others (capped at 30)
```
Priority auto-maps to impact level: `low→low`, `medium→moderate`, `high→high`.

**Effort (0-20):** SMEQ-based cognitive load score. Lower cognitive effort = higher score (WSJF throughput principle).
```
effortScore = max(1, round(20 * (1 - smeq / 150)))
SMEQ=0 → 20 (effortless)    SMEQ=150 → 1 (extreme)
```
SMEQ is inferred in order: `smeq_estimate` → `estimated_minutes` → `size_label` → keyword hints → category EMA baseline → default 65.

**Context (0-15):** Adaptive personalization.
```
Category bias (0-5): personal_bias[category] mapped 0.8..1.2 → 1..5
Streak bonus  (0-5): 1d→1, 3d→2, 7d→3, 14d→4, 30d→5
Momentum      (0-5): completions last 24h: 1→1, 3→3, 5→5
```

### Keyword Inference

On first sync, `inferMetadata(title, description)` auto-fills `category`, `irreversible`, and `affects_others` from title/description keywords. No external deps.

| Category | Keywords (sample) |
|----------|-------------------|
| `health` | doctor, gym, medicine, dentist, therapy, prescription, surgery |
| `finance` | bill, payment, invoice, tax, bank, rent, mortgage, insurance |
| `social` | birthday, anniversary, gift, family, friend, party, wedding |
| `work` | meeting, project, report, client, deadline, review, deploy |
| `tasks` | (default) |

Irreversible triggers: `birthday, anniversary, appointment, flight, exam, interview, surgery, deadline, wedding`
Affects-others triggers: `meeting, team, client, review, friend, family, gift, party, together, group`

### XP and Points

```
pointsAwarded    = round(basePoints * streakMultiplier * overdueBonus)
basePoints       = 10 + (score/100) * 90        // 10 (score=0) → 100 (score=100)
streakMultiplier = 1 + min(streak, 30) / 30      // 1.0x → 2.0x
overdueBonus     = 1.25 if completed overdue, else 1.0
```

### Achievements (9 total)

`first_task` · `ten_tasks` · `hundred_tasks` · `streak_3` · `streak_7` · `streak_30` · `thousand_points` · `high_scorer` (score ≥ 90) · `overdue_hero`

### Adaptive Learning (EMA, alpha=0.2)

After each completion, `category_stats` updates via exponential moving average:
```
new_avg_score             = prev * 0.8 + score * 0.2
new_avg_hours_to_complete = prev * 0.8 + hoursUntilDue * 0.2
personal_bias             = globalAvgHours / categoryAvgHours  (clamped 0.8..1.2)
```
Requires `completion_count >= 3` before bias affects the Context dimension. Adapts without manual resets as patterns change over time.

### Scoring Tool (LLM-accessible)

**File:** [src/tools/scoring.ts](src/tools/scoring.ts)

Six actions. The first three are read-only; the last three write to Supabase to close the adaptive learning loop.

| Action | Direction | Description |
|--------|-----------|-------------|
| `stats` | read | XP, streak, longest streak, completion count, recent achievements |
| `leaderboard` | read | Top N pending tasks sorted by computed score, with per-dimension breakdown. Triggers a Google Tasks sync first. |
| `achievements` | read | All achievements with unlock status and timestamp |
| `rate_effort` | write | Report post-task `smeq_actual` (0–150). Updates `scoring_events.smeq_actual` and EMA-shifts `category_stats.avg_smeq_actual` for the event's category. Closes the adaptive learning loop: future tasks in that category inherit the updated SMEQ baseline as their effort estimate. |
| `set_metadata` | write | Update scoring metadata on a `life_events` row (`smeq_estimate`, `size_label`, `impact_level`, `irreversible`, `affects_others`). Returns the recomputed score. |
| `add_event` | write | Create a non-Google life event (`source='discord'`) in any category. Runs keyword inference for `irreversible`/`affects_others` if not provided. Returns score preview. |

**Adaptive SMEQ loop via `rate_effort`:**
```
User completes task → LLM asks "how hard was that?"
  → rate_effort(life_event_id, smeq_actual=110)
  → scoring_events.smeq_actual = 110
  → category_stats.avg_smeq_actual = EMA(prev, 110)
  → next unrated task in same category uses new avg as effort baseline
```
Requires `completion_count >= 3` before the adapted baseline meaningfully diverges from the default 65.

### Setup

1. Create a Supabase project
2. Run `supabase/migrations/001_scoring_system.sql` in the SQL editor
3. Disable RLS on all five tables:
   ```sql
   ALTER TABLE user_profiles DISABLE ROW LEVEL SECURITY;
   ALTER TABLE life_events DISABLE ROW LEVEL SECURITY;
   ALTER TABLE scoring_events DISABLE ROW LEVEL SECURITY;
   ALTER TABLE category_stats DISABLE ROW LEVEL SECURITY;
   ALTER TABLE achievements DISABLE ROW LEVEL SECURITY;
   ```
4. Add to `settings.yaml`:
   ```yaml
   supabase:
     url: "https://your-project.supabase.co"
     anonKey: "sb_publishable_..."
   ```

Supabase is optional. If not configured, the scoring tool returns an error and background sync silently skips.

---

## Mood System

**Files:** [src/mood.ts](src/mood.ts), [src/tools/mood.ts](src/tools/mood.ts)

Tracks the bot's emotional state using Plutchik's wheel of emotions -8 primary emotions at 3 intensity levels (24 distinct states), with dyad resolution, opposition validation, and behavioral guidance injected into every prompt.

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

### Dyads (Combination Emotions)

When a primary and secondary emotion are adjacent on the wheel, they resolve to a named **dyad**:

| Primary | + Secondary | = Dyad |
|---------|-------------|--------|
| Joy | Trust | **Love** |
| Trust | Fear | **Submission** |
| Fear | Surprise | **Awe** |
| Surprise | Sadness | **Disapproval** |
| Sadness | Disgust | **Remorse** |
| Disgust | Anger | **Contempt** |
| Anger | Anticipation | **Aggressiveness** |
| Anticipation | Joy | **Optimism** |

`resolveDyad(primary, secondary)` returns the dyad name or null if the pair isn't adjacent. Both orderings are supported (joy+trust and trust+joy both resolve to "love").

### Opposition Pairs

Emotions directly across the wheel are opposites:

- Joy ↔ Sadness, Trust ↔ Disgust, Fear ↔ Anger, Surprise ↔ Anticipation

`areOpposites(a, b)` checks this. The auto-classifier drops a secondary emotion if it opposes the primary (treated as a classification error). The `set_mood` tool allows opposing pairs but returns a warning.

### MoodState

```typescript
type MoodState = {
  emotion: PrimaryEmotion;    // One of 8 primary emotions
  intensity: Intensity;        // "low" | "mid" | "high"
  secondary?: PrimaryEmotion;  // Optional blend (adjacent on wheel)
  note?: string;               // Brief context (max 200 chars)
  updatedAt: string;           // ISO timestamp
};
```

Persisted to `data/current-mood.json`. Survives restarts.

### Auto-Classification

After each Discord response, `classifyMood(botResponse, userMessage)` runs asynchronously (fire-and-forget):

1. Checks throttle -skips if mood was updated less than 30 seconds ago
2. Makes a lightweight direct LLM call (`max_completion_tokens: 512`, no tools, no full persona prompt)
3. Uses `enable_thinking: false` and a `/no_think` prefix in the user message to suppress extended thinking on models like Qwen3
4. The classifier prompt is Plutchik-aware: includes intensity scale guidance, wheel adjacency order for secondaries, and explicit opposition exclusion
5. Parses JSON response by extracting the first `{...}` object found anywhere in the output (tolerates models that emit surrounding text)
6. Validates against Plutchik's emotions enum; drops secondary if it opposes primary
7. Calls `saveMood()` → persists to disk + broadcasts SSE event (includes `dyad` field)

The classification uses `getLLMClient()` and `getAuxiliaryModel()` from `llm.ts` for a minimal API call -no system prompt, no tools, no history. Just a classifier prompt and the bot's response text.

### Manual Override

The `set_mood` tool allows the bot to express intentional mood shifts that auto-detection might miss. Its description lists all 8 dyad combinations so the LLM knows which pairs produce named blends. If the primary and secondary are opposites, the tool response includes a warning. Bypasses the classification throttle.

### Behavioral Guidance

`MOOD_GUIDANCE` maps each of the 24 emotion+intensity combinations to a one-line behavioral cue that tells the model how the emotion should color its tone:

- `joy/low`: "Calm, content, at ease. Let this color your tone without forcing it."
- `anger/high`: "Intense, barely contained. Responses are tight and cutting."
- `sadness/mid`: "Genuinely down. Empathy runs deeper, humor pulls back."

The guidance is generic enough to work across all personas but specific enough to meaningfully influence output.

### System Prompt Injection

`buildMoodPromptSection()` adds the current mood to every LLM request. When a dyad is resolved, the compound name appears with the constituent emotions in parentheses. Behavioral guidance is always appended:

```
## Current Mood
You are currently feeling **love** (joy with trust)  -  Genuinely happy, warm energy. Let it show naturally.
```

Without a dyad (primary only):
```
## Current Mood
You are currently feeling **serenity**  -  Calm, content, at ease. Let this color your tone without forcing it.
```

When no mood is set yet: `No mood set yet -it will be detected automatically from your responses.`

### Live Dashboard

`saveMood()` calls `broadcastEvent("mood", { ... })` which sends a named SSE event to all connected dashboard clients. The broadcast includes `dyad` (the resolved combination name, or null). The frontend listens for `mood` events on the existing `/api/logs/stream` EventSource and updates the active persona card in-place -colored dot, emotion label, and secondary emotion.

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
  firstSeen: string;      // ISO timestamp -first message ever
  lastSeen: string;       // ISO timestamp -most recent message
  messageCount: number;   // Total messages across all channels
  channels: string[];     // Channel IDs the user has been active in
};
```

Persisted to `data/users.json`. Updated on every Discord message via `updateUser()` (called in [src/discord/client.ts](src/discord/client.ts) alongside `recordMessage()`).

### API

- `GET /api/users` -all profiles
- `GET /api/users/:userId` -single profile + memory facts (from `user:{userId}` scope)
- `DELETE /api/users/:userId` -remove profile and cascade-delete user memory facts (`user:{userId}` scope)

### Difference from Sessions

Sessions ([src/sessions.ts](src/sessions.ts)) track per-channel stats -a user appears in each channel's `users` record independently. User profiles aggregate across channels into a single record per user.

---

## Cron System

**File:** [src/cron.ts](src/cron.ts)

Schedules jobs using `data/cron-jobs.json` as the single source of truth. Jobs are created via the `cron` tool, REST API, or web dashboard. Uses the `croner` library (cron expressions with timezone support).

### Architecture

The cron system uses a **file-based** architecture to prevent data loss:

- **Every read** loads from `data/cron-jobs.json`
- **Every write** saves atomically (write to temp file, then rename)
- **Only in-memory state** is a `Map<string, SchedulerEntry>` for live `Cron` timer instances -this is scheduling machinery only, never used as a data source
- After any write, `syncSchedulers()` reconciles live timers with the file contents

This design eliminates issues with ESM module duplication where multiple module instances could hold competing in-memory state.

### Job Types

| Type | Behavior |
|------|----------|
| `static` | Sends `job.message` literally to the configured channel |
| `llm` | Sends `job.prompt` to `getLLMOneShot()`, posts the LLM's response |

LLM-type jobs have full tool support -the LLM can call tools while generating the response.

### Silent Mode

Jobs can be created with `silent: true` to skip sending output to Discord. The job still executes (static or LLM), history is still recorded, but `sendToChannel()` is not called. When silent, `channelId` is not required. Useful for background tasks like periodic memory compaction or data cleanup.

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
4. Send to Discord channel (skipped if `silent: true`)
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

Slash commands registered on startup:

| Command | Description |
|---------|-------------|
| `/ask [prompt]` | Ask the bot with a rich embed response |
| `/tools` | List all tools and agents with status |
| `/ping` | Latency check |
| `/new` | Start a fresh session (clears history, summary, and context) |
| `/websearch [query] [count]` | Search the web (1-10 results, default 5) |
| `/memory [view/add/clear]` | View, add, or clear per-user memory facts |
| `/mood` | Show the bot's current emotional state |
| `/note [list/get/save/delete]` | Manage scoped notes |
| `/help` | List all available commands |
| `/reboot` | Graceful restart |
| `/play` | Launch the Discord Activity (embed with Link button) |

### attachments.ts

`processAttachments(message, textContent, model)`:

- **Images** (PNG/JPEG/GIF/WebP) on vision-capable models → `ContentPart` with `image_url`
- **Text files** (26 supported extensions, up to 100 KB) → downloaded and inlined
- **Other files** → placeholder noting the file type

### embeds.ts

Builders for Discord embeds:
- `buildResponseEmbed(text, model)` -accent-colored, splits at 4096 chars
- `buildErrorEmbed(msg)` -red
- `buildSuccessEmbed(text)` -green
- `buildToolListEmbed(tools, agents)` -formatted list with status indicators

---

## Web Dashboard

**Files:** [src/web.ts](src/web.ts), [public/](public/)

Express 5 server serving the dashboard frontend and REST API.

### API Documentation

The full API spec is an [OpenAPI 3.1](openapi.yaml) document served with interactive Swagger UI at `/api/docs` when the bot is running. The spec file lives at the project root (`openapi.yaml`).

**Auth:** Optional bearer token via `web.apiKey` in `settings.yaml`. When set, all `/api/*` routes (except `/api/status`, `/api/activity/*`, and `/api/docs`) require `Authorization: Bearer <key>`. SSE endpoints accept `?token=<key>` instead. No key configured = no auth.

**Rate limits:** 1000 req/15 min general, 60 req/min on chat endpoints.

**Route groups:** Status, Config, Persona (11 routes -includes `POST /api/personas` for creation), Chat (3), Cron (6), Sessions (4), Memory (7 -includes scoped lookup), Notes (5), Calendar (2 -per-user events + all-events aggregation), Tasks (5, requires `X-Discord-User-Id` header), Users (3), Tools (4 -list, detail, execute, toggle), Agents (2), System (5 -includes mood), Activity (2), Scoring (4), Life Events (2), Linear (15 -teams, projects, issues CRUD, search, comments, project updates), Knowledge Base (4 -stats, sync, chunks, delete), Ambient (3 -status, buffers, trigger toggle), Export (1) -~88 endpoints total.

### Routing

When `activity.enabled` is true:
- `/` serves `activity/index.html` with injected config (clientId, serverUrl) -this is what Discord's Activity iframe loads
- `/dashboard` serves the web dashboard (`public/index.html`)
- `/activity/*` serves Unity build files with CORS headers and gzip `Content-Encoding` for `.gz` files

When `activity.enabled` is false:
- `/` serves the web dashboard normally

### Frontend

Single-page vanilla JS app in `public/`. Dark design (#0c0c0e), Roboto font, purple accent (#a78bfa). Collapsible panels for each section. Live console via SSE `EventSource`. All controls (toggle, reload, reboot, LLM test) hit the REST API. The active persona card shows a **live mood indicator** (colored dot + emotion label) that updates via named SSE events -no page refresh needed.

Dashboard is organized into **7 tabs**: Home, Persona, Data, People, Automation, System, and Mindmap. The **Home tab** shows at-a-glance stat cards (mood, next event, next cron, streak), a two-column grid of widgets (upcoming events, recent tasks, persona summary, cron activity, scoring history), and an achievements strip. The **Persona tab** has persona card grid + file editor and LLM test. The **Data tab** covers Memory, Notes, and Knowledge Base (file table, stats, sync, chunk preview). The **People tab** has Sessions and Users. The **Automation tab** has Calendar events, Scheduled Tasks (cron), Tasks (with per-user lists, score badges and smart sort), and Scoring (XP bar, streak, leaderboard, achievements). The **System tab** has Tools, Agents, Activity Preview, Export, and Console (live log stream). The **Mindmap tab** provides a real-time visualization of LLM conversation processing using Cytoscape.js with a dagre (top-down) layout — showing conversation flow, memory lookups, KB searches, tool calls, fact extraction, and mood classification as an interactive graph. Events are broadcast via the existing SSE `broadcastEvent("mindmap", ...)` system from `src/llm.ts`, `src/fact-extractor.ts`, and `src/mood.ts`. A sidebar shows status, quick glance widget, and Discord user ID input. An **Export Data** button downloads a JSON bundle of all bot data.

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
    auxiliaryModel: string;     // Default: "" -lightweight model for ambient/mood (falls back to main model)
    systemPrompt: string;       // Overwritten by persona system at startup
    ambientSystemPrompt: string; // Default: "" -persona context for ambient engine (voice-only, no tools)
    maxTokens: number;          // Default: 16384
    maxHistory: number;         // Default: 50
    maxToolIterations: number;  // Default: 25 -max tool-calling rounds per request
    lite: boolean;              // Default: false -slim tool schemas for local models
    disableThinking: boolean;   // Default: false -strip <think> blocks from models that emit them
    verifyToolClaims: boolean;  // Default: true -validate tool call claims in LLM output
    maxVerificationRetries: number; // Default: 1 -retries for tool claim verification (0-3)
  };
  web: {
    enabled: boolean;
    port: number;
    apiKey?: string;
    basePath: string;           // Default: "" -URL prefix (e.g. "/aelora"), trailing slash stripped
    auth: {
      allowQueryToken: boolean; // Default: true -accept ?token= for SSE endpoints
      allowWsQueryToken: boolean; // Default: true -accept ?token= for WebSocket
    };
  };
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
  memory: {
    maxFactsPerScope: number;   // Default: 100
    maxFactLength: number;      // Default: 1000
    maxAgeDays: number;         // Default: 0 (0 = no TTL, keep forever)
    autoExtract: boolean;       // Default: true -auto-extract facts from conversations
    vectorSearch: boolean;      // Default: true -enable semantic vector search
    embeddingModel: string;     // Default: "text-embedding-3-small"
    embeddingDimensions: number; // Default: 1536
    embeddingBaseURL: string;   // Default: "https://api.openai.com/v1"
    embeddingApiKey: string;    // Default: "" -separate key for embedding provider
    semanticDedupThreshold: number; // Default: 0.85 -similarity threshold for deduplication
    semanticSearchTopK: number; // Default: 10 -max results from vector search
    semanticSearchMinScore: number; // Default: 0.3 -minimum similarity to include
    consolidationEnabled: boolean;  // Default: true -LLM-powered fact merging
    consolidationThreshold: number; // Default: 10 -new facts before consolidation runs
  };
  logger: {
    maxBuffer: number;          // Default: 200, SSE circular buffer size
    fileEnabled: boolean;       // Default: false -write logs to data/logs/
    retainDays: number;         // Default: 7 -how many days of log files to keep
  };
  cron: {
    maxHistory: number;         // Default: 10 -execution records per job
  };
  knowledge: {
    enabled: boolean;           // Default: false
    driveFolderId: string;      // Google Drive folder ID to sync
    syncIntervalMinutes: number; // Default: 30
    chunkSize: number;          // Default: 800 -characters per chunk
    chunkOverlap: number;       // Default: 100 -overlap between chunks
    maxChunksPerPrompt: number; // Default: 5 -max chunks injected into system prompt
    minRelevanceScore: number;  // Default: 0.35 -minimum similarity to include
  };
  ambient: {
    enabled: boolean;           // Default: false
    bufferSize: number;         // Default: 100 -max messages per channel buffer
    evaluationIntervalMs: number; // Default: 300000 (5 min)
    globalRateLimitPerHour: number; // Default: 6
    channelCooldownMinutes: number; // Default: 15
    minBufferMessages: number;  // Default: 3 -min messages before evaluating a channel
    triggers: {
      converse: { enabled: boolean; cooldownMinutes: number; skipChance: number; minMessages: number; minUsers: number; windowMinutes: number };
      imageReact: { enabled: boolean; cooldownMinutes: number; skipChance: number; minAgeMinutes: number; maxAgeMinutes: number };
    };
  };
  supabase?: {
    url: string;
    anonKey: string;
  };
};
```

---

## Supporting Systems

### boot.ts - Process Wrapper

[src/boot.ts](src/boot.ts) spawns `index.ts` (or `index.js` in production) as a child process. If the child exits with code **100**, it restarts automatically. Any other exit code propagates normally. This enables graceful reboots from Discord (`/reboot`) and the web dashboard without external process managers.

### lifecycle.ts - Reboot

`reboot()` stops heartbeat, stops cron, then calls `process.exit(100)`. The boot wrapper catches code 100 and restarts.

### logger.ts - Console Capture + File Logging

`installLogger()` patches `console.log`, `console.warn`, `console.error` at startup. Every call:
1. Passes through to the original console method (terminal output)
2. Pushes a `LogEntry` into a configurable circular buffer (default 200 entries)
3. Broadcasts the entry as an SSE event to all connected dashboard clients
4. Appends to `data/logs/YYYY-MM-DD.log` when `logger.fileEnabled` is true

**File logging:** When enabled, each log line is written as `[ISO timestamp] [LEVEL] message`. One file per day, append-only. On startup, log files older than `logger.retainDays` (default 7) are automatically deleted.

`broadcastEvent(event, data)` sends **named** events to all connected SSE and WebSocket clients. Used by the mood system to push live updates -the dashboard listens for `event: mood` on the same `/api/logs/stream` EventSource, and WebSocket clients receive `{ type: "event", event, data }` frames.

### daily-log.ts - Activity Logging

Automatic daily activity logging, persisted to disk. Uses the configured timezone for date formatting.

### utils.ts - Shared Utilities

`chunkMessage(text, maxLength = 2000)` -splits text into Discord-safe chunks, respecting newline boundaries where possible.

### Process Error Handlers

`index.ts` registers handlers for `uncaughtException` and `unhandledRejection` that log the error, save conversations and state, then exit with code 1. The boot wrapper (`boot.ts`) only restarts on exit code 100 (graceful reboot), so crashes exit cleanly.

---

## Vector Memory System

**Files:** [src/vector-store.ts](src/vector-store.ts), [src/memory.ts](src/memory.ts), [src/migrate-vectors.ts](src/migrate-vectors.ts)

Semantic search layer over the enriched fact store (`data/memory.json`). Uses [Vectra](https://github.com/Stevenic/vectra) for local vector indexing with OpenAI-compatible embedding APIs.

### Enriched Fact Model

Each fact carries structured metadata beyond the raw text:

```typescript
type MemoryFact = {
  fact: string;
  savedAt: string;
  category: "preference" | "biographical" | "behavioral" | "relationship" | "technical" | "contextual";
  confidence: "stated" | "inferred";
  source: string;           // "channel:123", "manual", "legacy", "consolidation"
  lastAccessedAt?: string;
  accessCount?: number;
};
```

**Categories** classify what kind of information the fact represents (preferences, biographical details, communication style, etc.). **Confidence** tracks whether the user explicitly stated the fact or it was inferred from context. **Source** records where the fact came from. Legacy facts are auto-migrated on first load.

### How It Works

1. **Indexing:** When a fact is saved via `saveFact()`, it's also embedded and upserted into the Vectra index at `data/vectors/memory/`. Vector metadata includes `category`, `confidence`, and `source`.
2. **Semantic dedup:** Before saving a new fact, `isDuplicateSemantic()` queries the index for high-similarity matches (configurable threshold). This replaces the Jaccard keyword fallback when the vector store is available.
3. **Semantic search:** `semanticSearch()` returns the top-K most relevant facts across specified scopes, ranked by cosine similarity. Used by the memory tool for smarter recall.
4. **Weighted ranking:** When injecting facts into the system prompt, `rankFact()` blends semantic similarity (70%), temporal recency with exponential decay (20%), and access frequency boost (10%). This ensures frequently-accessed and recently-saved facts rank higher than stale ones.
5. **Access tracking:** Facts injected into the system prompt have their `lastAccessedAt` and `accessCount` updated (debounced save every 10 seconds to avoid disk thrashing).
6. **LRU cache:** Recent embeddings are cached in-memory (100 entries) to avoid redundant API calls for repeated text.
7. **Batch rebuild:** `rebuildIndex()` re-embeds all facts from the JSON store in batches of 100. Run automatically on first boot if the vector index is missing, or manually via `npx tsx src/migrate-vectors.ts`.

### Config

```yaml
memory:
  vectorSearch: true
  embeddingApiKey: "sk-..."          # OpenAI-compatible embedding API key
  embeddingBaseURL: "https://api.openai.com/v1"
  embeddingModel: "text-embedding-3-small"
  embeddingDimensions: 1536
  semanticDedupThreshold: 0.85      # cosine similarity threshold for dedup
  semanticSearchTopK: 10            # max results per query
  semanticSearchMinScore: 0.3       # minimum similarity to return
  consolidationEnabled: true        # enable periodic fact consolidation
  consolidationThreshold: 10        # new facts before triggering merge
```

---

## Fact Extraction & Personality Synthesis

**Files:** [src/fact-extractor.ts](src/fact-extractor.ts)

Fire-and-forget system that automatically extracts noteworthy facts from conversations, detects contradictions with existing knowledge, and builds personality profiles. Same lightweight pattern as the mood system.

### Extraction Pipeline

1. **Throttle check:** Per-channel cooldown (2 minutes) and minimum message count (4 messages) between extractions.
2. **Context injection:** Up to 15 recent user facts and 10 channel facts are appended to the extraction prompt, enabling the LLM to detect contradictions against existing knowledge.
3. **LLM extraction:** Sends the latest user+bot exchange to the auxiliary model with a structured JSON prompt. Each fact is returned as an object with `fact`, `category` (one of 6 types), and `confidence` ("stated" or "inferred"). Also returns a `contradictions` array for mutually exclusive facts (changed preferences, moved location, etc.). Plain string arrays are accepted as a fallback for model compatibility.
4. **Contradiction resolution:** For each detected contradiction, the old fact is found and deleted from the JSON store and vector index before the replacement is saved.
5. **Dedup:** Each candidate fact is checked against existing facts using semantic dedup (vector store) with Jaccard keyword fallback.
6. **Save:** Deduplicated facts are saved with full metadata (`category`, `confidence`, `source`) to the appropriate scope in `data/memory.json` and indexed in the vector store. Caps per extraction: 3 user, 2 personality, 2 channel, 1 global.

### Fact Categories

| Category | What it captures |
|----------|-----------------|
| `preference` | Likes, dislikes, opinions, tastes |
| `biographical` | Name, location, job, age, pets, family |
| `behavioral` | Communication style, habits, patterns, tone |
| `relationship` | Dynamics with others, social context |
| `technical` | Tools, languages, projects, skills |
| `contextual` | Situational facts, current events, plans |

### Personality Synthesis

After a user accumulates 5+ facts, the system auto-generates a 3-4 sentence personality profile via LLM. Re-synthesizes every 3 new facts. The profile is stored on `UserProfile.personalitySummary` and injected into the system prompt under `## Current User`, giving the bot persistent awareness of each user's communication style, preferences, and context.

---

## State & Persistence

| Data | Storage | Survives restart? |
|------|---------|-------------------|
| Conversation history | In-memory Map + periodic disk save (`data/memory/conversations.json`) | Yes (saved every 5 min by heartbeat) |
| Notes | `data/notes.json` (disk) | Yes |
| Tasks | Google Tasks API (per-user lists) | Yes |
| Tool/agent enabled state | `data/toggle-state.json` (disk) | Yes |
| Cron jobs + execution history | `data/cron-jobs.json` (disk, atomic writes) | Yes |
| Memory facts | `data/memory.json` (disk) | Yes |
| Sessions | `data/sessions.json` (disk) | Yes |
| Daily log | `data/daily-log/` (disk) | Yes |
| Mood state | `data/current-mood.json` (disk) | Yes |
| Conversation summaries | `data/memory/summaries.json` (disk) | Yes |
| Active persona | `data/bot-state.json` (disk) | Yes |
| User profiles (Discord) | `data/users.json` (disk) | Yes |
| Scoring user profiles | Supabase `user_profiles` table | Yes |
| Life events (tasks + metadata) | Supabase `life_events` table | Yes |
| Scoring history | Supabase `scoring_events` table | Yes |
| Per-category adaptive stats | Supabase `category_stats` table | Yes |
| Achievements | Supabase `achievements` table | Yes |
| Vector embeddings | `data/vectors/memory/` (Vectra local index) | Yes |
| Calendar event notifications | `data/notified-events.json` (disk) | Yes |
| Heartbeat notified events (legacy) | In-memory Set | No |
| Log buffer | In-memory circular array (200 entries) | No |
| Log files | `data/logs/YYYY-MM-DD.log` (disk, when `logger.fileEnabled`) | Yes |
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

A standalone page that loads Unity without the Discord SDK -uses stub user data instead. Accessible from the dashboard's "Activity Preview" panel or directly at `/activity/test.html`.

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
4. Restart the bot -it auto-loads
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
5. Restart -auto-loads. Verify in console.

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
4. Bootstrap rules are inherited from `_shared/bootstrap.md` -no per-persona bootstrap needed (unless overriding)
5. Edit the generated `soul.md` to define the character's behavioral core using the SOUL Authoring Blueprint
6. Switch to the new character from the dashboard card grid or via `POST /api/persona/switch`
7. The `{{botName}}` variable resolves to this character's name automatically

### Adding a Cron Job

Create via the REST API (`POST /api/cron`), the web dashboard, or ask the bot to create one using the `cron` tool. Jobs persist to `data/cron-jobs.json` and survive restarts.

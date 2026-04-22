# Aelora

<p align="center">
  <img src="assets/aelora_art_04.png" alt="Aelora" width="320" />
</p>

**An open-source LLM harness that turns any OpenAI-compatible model into a persistent, tool-using, emotionally aware agent.**

The model provides reasoning. Aelora provides everything else — memory, tools, personality, context engineering, and real-time emotional state. Built as the embodiment layer of the **Luminora Emotion Engine** within the Aeveon creative universe.

## Harness Subsystems

| Subsystem | What it does |
|---|---|
| **Orchestration Loop** | Message in → system prompt assembly → streaming completion with multi-step tool dispatch → post-response extraction (facts, mood, tokens) |
| **Memory** | Per-user/channel/global fact store with 12 categories, vector semantic search, contradiction detection, weighted ranking, temporal awareness, periodic LLM consolidation |
| **Context Engineering** | System prompt built in cache-friendly order (static persona first, dynamic context last), conversation compaction via summarization, per-section token budgets, tool relevance filtering |
| **Tool System** | Auto-discovered from `src/tools/*.ts` — drop a file, it loads. 15+ built-in tools (Google Workspace, Linear, web search, image gen). Dynamic relevance filtering, parallel execution |
| **Agent System** | Sub-LLM loops with own system prompts, tool allowlists, and iteration caps. Auto-discovered from `src/agents/*.ts`. Agents inherit the persona voice |
| **Knowledge Base** | Google Drive folder synced, chunked, embedded, and vector-indexed. Auto-searched every message, injected as reference material |
| **Personality & Emotion** | Composable persona from layered markdown files. Plutchik 8D mood classification per response. Real-time emotion vectors for 3D animation |
| **Automation** | Heartbeat system (calendar reminders, memory compaction, cleanup, KB sync, ambient awareness), cron scheduler with timezone support |
| **Observability** | Centralized token tracking (lifetime/daily/hourly/by-model/by-source), 7-tab web dashboard, WebSocket broadcasting |

## How It Works

```text
                    Discord / REST API / WebSocket
                                │
                                ▼
                    ┌───────────────────────┐
                    │   System Prompt Build  │
                    │                        │
                    │  Persona (static)      │  ◄── cache-friendly order:
                    │  + Tool inventory      │      static sections first,
                    │  + Mood state          │      dynamic sections last
                    │  + User profile        │
                    │  + Memory (ranked)     │
                    │  + Knowledge base hits │
                    │  + Conversation summary│
                    │  + Date/time           │
                    └──────────┬────────────┘
                               │
                               ▼
                    ┌───────────────────────┐
                    │   Completion Loop      │
                    │                        │
                    │  LLM call (streaming) ─┼──► token-by-token output
                    │       │                │
                    │       ▼                │
                    │  Tool calls? ──yes──►  │──► tool-registry dispatch
                    │       │       │        │    (parallel execution)
                    │       no    results    │
                    │       │     re-inject  │
                    │       ▼       │        │
                    │  Agent calls? ─yes──►  │──► sub-LLM loop (own prompt,
                    │       │                │    own tools, iteration cap)
                    │       no               │
                    │       ▼                │
                    │     Done               │
                    └──────────┬────────────┘
                               │
                               ▼
                    ┌───────────────────────┐
                    │   Post-Response        │
                    │                        │
                    │  Fact extraction       │  async LLM pass: 12 categories,
                    │  Mood classification   │  contradiction detection,
                    │  Token accounting      │  temporal date resolution
                    │  Profile rebuild       │
                    │  Mindmap broadcast     │
                    └───────────────────────┘
```

## Design Philosophy

- **Model-agnostic.** Any OpenAI-compatible endpoint: OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio. Swap models without changing anything else.
- **Personality-first.** The persona system is not an afterthought. Composable markdown files define the agent's voice, and every subsystem — agents, mood, ambient awareness — respects it.
- **Convention over configuration.** Drop a `.ts` file in `src/tools/` or `src/agents/` and it auto-loads. No registration boilerplate.
- **Context is a scarce resource.** Every injection section has a token budget. History is compacted, not truncated. The system prompt is ordered for prefix caching.
- **Memory is durable.** Facts persist across sessions with semantic search, temporal awareness, and periodic LLM-driven consolidation. The bot remembers.

## Interfaces

| Interface | Transport | Use case |
|---|---|---|
| **Discord** | Discord.js | Primary conversational interface with ambient awareness |
| **REST API** | Express | Full CRUD for all subsystems, OpenAPI spec at `/api/docs` |
| **WebSocket** | `/ws` | Bidirectional streaming chat + topic-subscribed event bus (chat, emotion, mindmap, logs, tokens, heartbeat) with permessage-deflate |
| **Web Dashboard** | Browser | 7-tab real-time visualization, data management, persona editing |
| **Discord Activity** | Embedded iframe | ThreeJS web frontend in Discord voice channels via `/play` (Unity WebGL support retired) |

---

<details>
<summary><strong>Features</strong></summary>

- **LLM Chat** - Any OpenAI-compatible endpoint (OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio)
- **Streaming** - Token-by-token streaming to Discord, dashboard, and WebSocket clients
- **Persona System** - Composable personality from layered markdown files with hot-reload
- **Tool Framework** - Drop a `.ts` file in `src/tools/`, it auto-loads with typed params and config resolution
- **Agent Framework** - Sub-agents with their own system prompts, tool allowlists, and reasoning loops
- **Smart Memory** - Per-user and per-channel fact storage with 12 enriched categories, temporal awareness (expiresAt/relevantDate with auto-expiry), semantic search via vector embeddings (Vectra + OpenAI), auto-extraction with contradiction detection, weighted ranking (semantic relevance + recency + access frequency + temporal boost), periodic consolidation, and pre-response message triage
- **Per-User Profiles** - LLM-synthesized markdown dossiers per user (`data/users/{userId}.md`), always injected into system prompt, auto-rebuilt as the bot learns more
- **Token Usage Tracking** - Centralized tracking of all LLM token usage with lifetime/daily/hourly/by-model/by-source breakdowns, persisted to disk, dashboard stat card
- **Web Search** - Configurable provider (Brave or OpenAI Responses API)
- **Google Tasks** - Full task management: list, create, complete, update, delete (per-user task lists)
- **Google Calendar** - Full calendar CRUD with event reminders via heartbeat (per-user calendars)
- **Gmail** - Read, send, search, label, and trash messages
- **Google Docs** - Read, create, append, search documents
- **Knowledge Base** - Sync a Google Drive folder to the vector index; files (Docs, PDFs, text, Sheets, images) are chunked, embedded, and auto-searched on every message
- **Linear** - Issue tracking and project management (issues CRUD, projects, teams, search, comments, GraphQL)
- **Quests** - Personal quest system via Supabase (create, complete, list, favorite) with completion logs
- **Notes** - Persistent notes scoped to channels or global
- **Date Resolution** - Natural language date parsing (chrono-node) for accurate scheduling
- **Cron Jobs** - Scheduled messages (static or LLM-generated) with timezone support, silent mode, runtime CRUD
- **Sessions** - Conversation tracking with metadata, persisted to disk
- **Daily Log** - Automatic daily activity logging
- **User Profiles** - Per-user tracking across channels with detail overlay and cascading delete
- **Image Generation** - DALL-E 3 / gpt-image-1 via the luminizer tool
- **Heartbeat** - Periodic handlers for calendar reminders, memory compaction, fact consolidation, data cleanup, knowledge base sync
- **Discord Activity** - Embedded ThreeJS web frontend in Discord voice channels via `/play` (Unity WebGL retired; Activity iframe + OAuth flow unchanged)
- **Mood System** - Plutchik's wheel emotion tracking (8 emotions x 3 intensities, 8 named dyad combinations), auto-classified per response
- **Real-Time Emotion Vectors** - Continuous 8D emotion vectors broadcast during LLM streaming via heuristic lexicon analysis for 3D mesh animation
- **Ambient Awareness** - Passive channel monitoring with message buffers, engagement tracking, and configurable triggers that let the bot join conversations naturally
- **Web Dashboard** - 7-tab layout (Home, Persona, Data, People, Automation, System, Mindmap) with stat cards, live console, real-time LLM visualization, and full data management
- **WebSocket Chat + Event Bus** - Bidirectional chat over `/ws` for the ThreeJS frontend and other browser clients, with topic-subscribed broadcast (`chat`, `emotion`, `mindmap`, `logs`, `tokens`, `heartbeat`), permessage-deflate compression, and opt-in binary frames for high-rate emotion vectors
- **HTTP/2 Keepalive to LLM** - Undici global dispatcher reuses one TLS+H2 connection across every LLM call (connection pool visible at `GET /api/llm/transport`)
- **Provider Prompt Caching** - Static system-prompt prefix is scoped by `persona+channel` and sent with `prompt_cache_key` to boost prefix-cache hit rate; cached tokens tracked as a separate field in `/api/tokens` and on the dashboard
- **Cross-Request Embedding Cache** - LRU+TTL cache (cap 2000) in `src/vector-store.ts` dedupes embedding API calls across messages; stats at `GET /api/llm/transport`
- **Auto-Restart** - Process wrapper with graceful reboot via exit code signal
- **Async Persistence Queue** - Debounced/coalesced async writes (`users.json`, `daily-log`, token stats, summaries, conversations) with bounded flush, atomic rename, and graceful shutdown draining

</details>

---

<details>
<summary><strong>Quick Start</strong></summary>

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An LLM API key (OpenAI, or any compatible provider)

### Setup

```bash
git clone <your-repo-url>
cd aelora
npm install
cp settings.example.yaml settings.yaml
# Edit settings.yaml with your tokens and keys
npm run dev
```

Or double-click `start.bat` on Windows.

### Invite the Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application > OAuth2 > URL Generator
3. Scopes: `bot`, `applications.commands`
4. Permissions: `Send Messages`, `Read Message History`, `Embed Links`, `Attach Files`
5. Open the generated URL to invite the bot

</details>

---

<details>
<summary><strong>Configuration</strong></summary>

All configuration lives in `settings.yaml`. See [settings.example.yaml](settings.example.yaml) for the full reference.

| Section | What it controls |
|---|---|
| `timezone` | IANA timezone for the server (cron, logs, date formatting) |
| `discord` | Bot token, response mode (mention/all), allowed channels, DMs, status |
| `llm` | API endpoint, model, max tokens, conversation history length, auxiliaryModel, lite mode |
| `persona` | Personality system toggle, directory, bot name, active persona |
| `tools` | Per-tool config (API keys, Google OAuth credentials, etc.) |
| `agents` | Agent system toggle, max iterations |
| `heartbeat` | Periodic handler system interval (default: 15 min) |
| `memory` | Max facts per scope, categories, temporal expiry, vector search, embedding config, consolidation, triage |
| `logger` | SSE buffer size, file logging toggle, log file retention |
| `cron` | Max execution history records per job |
| `web` | Dashboard toggle, port, apiKey, basePath, auth compatibility flags |
| `activity` | Discord Activity toggle, client ID/secret, server URL |
| `knowledge` | Google Drive knowledge base: folder ID, sync interval, chunk size, relevance threshold |
| `ambient` | Ambient-awareness trigger system (buffer, cadence, per-trigger cooldowns) |
| `supabase` | Supabase project URL and keys (for quests and per-user data) |

### Environment Variables

All settings can be overridden with environment variables:

| Variable | Overrides |
|---|---|
| `AELORA_DISCORD_TOKEN` | `discord.token` |
| `AELORA_LLM_API_KEY` | `llm.apiKey` |
| `AELORA_LLM_BASE_URL` | `llm.baseURL` |
| `AELORA_WEB_API_KEY` | `web.apiKey` |
| `AELORA_WEB_PORT` | `web.port` |
| `AELORA_LINEAR_API_KEY` | `tools.linear.apiKey` |
| `AELORA_EMBEDDING_API_KEY` | `memory.embeddingApiKey` |
| `AELORA_EMBEDDING_BASE_URL` | `memory.embeddingBaseURL` |
| `AELORA_SUPABASE_URL` | `supabase.url` |
| `AELORA_SUPABASE_ANON_KEY` | `supabase.anonKey` |
| `AELORA_SUPABASE_SERVICE_ROLE_KEY` | `supabase.serviceRoleKey` |
| `AELORA_KB_DRIVE_FOLDER_ID` | `knowledge.driveFolderId` |
| `AELORA_ACTIVITY_CLIENT_ID` | `activity.clientId` |
| `AELORA_ACTIVITY_CLIENT_SECRET` | `activity.clientSecret` |
| `AELORA_LLM_HTTP2` | `llm.http2Enabled` — kill-switch for undici dispatcher |
| `AELORA_LLM_PROMPT_CACHE` | `llm.promptCacheEnabled` — kill-switch for provider prompt-cache hints |
| `AELORA_LLM_PROVIDER_HINT` | `llm.providerHint` (`auto` \| `openai` \| `anthropic`) |

</details>

---

<details>
<summary><strong>Google Workspace Setup</strong></summary>

Gmail, Google Calendar, Google Docs, and Google Tasks all use OAuth2 with a refresh token.

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable under **APIs and Services > Library**:
   - Gmail API
   - Google Calendar API
   - Google Docs API
   - Google Tasks API
   - Google Drive API

### 2. Create OAuth2 Credentials

1. Go to **APIs and Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Application type: **Web application**
4. Authorized redirect URIs: `https://developers.google.com/oauthplayground`
5. Copy the Client ID and Client Secret

### 3. Generate a Refresh Token

1. Go to [Google OAuth Playground](https://developers.google.com/oauthplayground/)
2. Click the gear icon > check **Use your own OAuth credentials**
3. Enter your Client ID and Client Secret
4. Select scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/drive.readonly`
5. Authorize, exchange the code, copy the **Refresh Token**

### 4. Add to Settings

```yaml
tools:
  google:
    clientId: "your-client-id.apps.googleusercontent.com"
    clientSecret: "your-client-secret"
    refreshToken: "1//your-refresh-token"
```

</details>

---

<details>
<summary><strong>Knowledge Base (Google Drive)</strong></summary>

Sync a Google Drive folder so the bot can automatically reference shared documents when responding. Files are periodically fetched, chunked, embedded into the vector index, and semantically searched on every incoming message.

**Supported file types:**
- Google Docs (exported as plain text)
- PDFs (text extracted via pdf-parse)
- Plain text, Markdown, CSV, JSON, XML
- Google Sheets (exported as CSV)
- Images (uses the file's description from Drive metadata)

**Setup:**

1. Create or choose a Google Drive folder for your team's reference material
2. Copy the folder ID from the URL (the string after `/folders/`)
3. Add to `settings.yaml`:

```yaml
knowledge:
  enabled: true
  driveFolderId: "YOUR_FOLDER_ID"
```

Or set `AELORA_KB_DRIVE_FOLDER_ID` as an environment variable.

The bot syncs every 30 minutes by default. Relevant excerpts appear automatically in responses as a "Reference Material" section.

</details>

---

<details>
<summary><strong>Persona System</strong></summary>

Aelora's personality is composed from markdown files in `persona/`. Each file has YAML frontmatter controlling load order, enable/disable, and section labels.

```markdown
---
order: 10
enabled: true
label: "Aelora Soul"
section: soul
botName: "Aelora"
---

# Soul: Aelora

You are **{{botName}}**, the embodiment layer of the Luminora Emotion Engine...
```

Files are sorted by `order`, concatenated, and injected as the system prompt. Variables like `{{botName}}` are substituted from config. Personas can be hot-reloaded from the web dashboard.

</details>

---

<details>
<summary><strong>Memory System</strong></summary>

Aelora has a multi-layered memory system:

### Fact Extraction (12 categories)
Facts are automatically extracted from conversations using an async LLM pass. Each fact is categorized as one of: `preference`, `biographical`, `behavioral`, `relationship`, `technical`, `contextual`, `task`, `goal`, `sentiment`, `life_event`, `social`, `opinion`.

### Temporal Awareness
Facts can have `expiresAt` and `relevantDate` fields. Relative dates ("tomorrow", "next Friday") are resolved to absolute ISO dates at extraction time. Categories have default expiry periods: tasks (7 days), sentiment (30 days), life events (90 days).

### Pre-Response Triage
A lightweight async LLM call runs on each incoming message before the bot responds, extracting dates, named entities, sentiment signals, and action items. Results feed into the full fact extraction pass.

### Per-User Profiles
When enough facts accumulate (5+ total, rebuilt every 3 new), an LLM synthesizes all user facts into a structured markdown dossier at `data/users/{userId}.md`. Sections: Identity, Personality & Style, Interests & Preferences, Technical, Relationships & Social, Goals & Current Focus, Recent Context. Always injected into the system prompt (3500 char cap).

### Prompt Injection
Up to 10 user facts + 10 channel facts + 5 global facts are injected per conversation, ranked by semantic relevance (70%), recency (20%), and access frequency (10%). Facts with `relevantDate` within 48 hours get a 1.5x boost and appear in a dedicated "Upcoming" section.

### Token Usage Tracking
Every LLM call across the system is instrumented. Stats are available at `GET /api/tokens` with breakdowns by lifetime, today, hourly (48h rolling), model, and source (chat, extraction, triage, mood, consolidation, ambient, compaction, profile, correction, synthesis).

</details>

---

<details>
<summary><strong>Tools and Agents</strong></summary>

### Adding a Tool

Create a file in `src/tools/`. It auto-loads on startup:

```typescript
import { defineTool, param } from "./types.js";

export default defineTool({
  name: "my-tool",
  description: "Does something useful.",
  params: {
    input: param.string("The input to process.", { required: true }),
  },
  handler: async ({ input }) => {
    return {
      text: `Processed: ${input}`,
      data: { input, processedAt: new Date().toISOString() },
    };
  },
});
```

### Built-in Tools

| Tool | Description |
|---|---|
| `tasks` | Google Tasks CRUD (per-user lists) |
| `google_calendar` | Google Calendar CRUD (per-user calendars) |
| `gmail` | Gmail read, send, search, label, draft |
| `google_docs` | Google Docs read, create, append, search |
| `web_search` | Web search (Brave or OpenAI) |
| `memory` | Persistent memory with semantic search |
| `notes` | Scoped note storage |
| `cron` | Scheduled job management |
| `set_mood` | Manual emotion control |
| `date` | Natural language date resolution |
| `linear` | Linear issue tracking (full CRUD) |
| `luminizer` | Image generation (DALL-E 3 / gpt-image-1) |
| `quest` | Patyna quest system (Supabase) |
| `discord_history` | Discord message history queries |
| `ping` | Connectivity test |

### Agents

| Agent | Tools | Description |
|---|---|---|
| `researcher` | web_search, notes | Research topics, synthesize, save notes |
| `sprint_planner` | linear | Plan sprints from Linear backlog |
| `standup` | linear | Generate standup reports |

</details>

---

<details>
<summary><strong>Slash Commands</strong></summary>

| Command | Description |
|---|---|
| `/ask [prompt]` | Ask the bot with a rich embed response |
| `/tools` | List all tools and agents with status |
| `/ping` | Latency check |
| `/new` | Start a fresh session (clears history, summary, and context) |
| `/websearch [query] [count]` | Search the web (1-10 results) |
| `/memory view` | View your remembered facts |
| `/memory add [fact]` | Remember a fact |
| `/memory clear` | Clear all your remembered facts |
| `/mood` | Show the bot's current emotional state |
| `/note list [scope]` | List notes in a scope |
| `/note get [scope] [title]` | Read a note |
| `/note save [scope] [title] [content]` | Create or update a note |
| `/note delete [scope] [title]` | Delete a note |
| `/help` | List all available commands |
| `/reboot` | Graceful restart |
| `/play` | Launch the Discord Activity in a voice channel |

</details>

---

<details>
<summary><strong>API Reference</strong></summary>

Full OpenAPI spec available at `/api/docs` when running, or see [openapi.yaml](openapi.yaml).

### Status & Config
| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Bot connection, uptime, guild count |
| GET | `/api/config` | Sanitized config (no secrets) |
| GET | `/api/tokens` | Token usage stats (lifetime, today, hourly, by-model, by-source) — includes `cachedTokens` (subset of `inputTokens` served from provider prompt cache) |
| POST | `/api/tokens/reset` | Reset token counters |
| GET | `/api/heartbeat` | Heartbeat handler status |
| GET | `/api/llm/transport` | LLM transport diagnostics: `{ transport: { enabled, opened, closed, requests, inflight }, embeddingCache: { size, hits, misses, hitRate }, asyncWriteQueue: { queuedFiles, queuedBytes, flushFailures } }` |

### Chat
| Method | Path | Description |
|---|---|---|
| POST | `/api/chat` | Send message, get response |
| POST | `/api/chat/stream` | Streaming chat (SSE) |
| DELETE | `/api/chat/:sessionId` | Clear session |

### Memory & Facts
| Method | Path | Description |
|---|---|---|
| GET | `/api/memory` | All facts across all scopes |
| GET | `/api/memory/scope?name=` | Facts for specific scope |
| DELETE | `/api/memory/:scope/:index` | Delete fact by index |
| DELETE | `/api/memory/:scope` | Clear scope |
| GET | `/api/memory/logs` | Available log dates |
| GET | `/api/memory/logs/:date` | Read daily log |
| GET | `/api/memory/summaries` | Conversation summaries |

### Sessions
| Method | Path | Description |
|---|---|---|
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:channelId` | Session detail + facts |
| DELETE | `/api/sessions/:channelId` | Delete session |
| DELETE | `/api/sessions` | Clear all sessions |

### Persona
| Method | Path | Description |
|---|---|---|
| GET | `/api/persona` | Active persona info |
| POST | `/api/persona/reload` | Reload from disk |
| GET | `/api/personas` | List available personas |
| POST | `/api/persona/switch` | Switch persona |
| GET | `/api/persona/files` | All persona files with content |
| PUT | `/api/persona/file` | Update file |
| POST | `/api/persona/file` | Create file |
| DELETE | `/api/persona/file` | Delete file |
| POST | `/api/personas` | Create new persona |

### Tasks (Google Tasks)
| Method | Path | Description |
|---|---|---|
| GET | `/api/tasks` | List tasks (header: `X-Discord-User-Id`) |
| GET | `/api/tasks/:uid` | Get single task |
| POST | `/api/tasks` | Create task |
| PUT | `/api/tasks/:uid` | Update/complete task |
| DELETE | `/api/tasks/:uid` | Delete task |

### Calendar (Google Calendar)
| Method | Path | Description |
|---|---|---|
| GET | `/api/calendar/events` | User's events |
| GET | `/api/calendar/all-events` | All users' events |

### Notes
| Method | Path | Description |
|---|---|---|
| GET | `/api/notes` | All notes |
| GET | `/api/notes/:scope` | Notes in scope |
| GET | `/api/notes/:scope/:title` | Single note |
| PUT | `/api/notes/:scope/:title` | Create/update |
| DELETE | `/api/notes/:scope/:title` | Delete |

### Users
| Method | Path | Description |
|---|---|---|
| GET | `/api/users` | All user profiles |
| GET | `/api/users/:userId` | Profile + facts |
| DELETE | `/api/users/:userId` | Delete (cascading) |

### Tools & Agents
| Method | Path | Description |
|---|---|---|
| GET | `/api/tools` | List all tools |
| GET | `/api/tools/:name` | Tool details |
| POST | `/api/tools/:name/execute` | Execute tool |
| POST | `/api/tools/:name/toggle` | Enable/disable |
| GET | `/api/agents` | List all agents |
| POST | `/api/agents/:name/toggle` | Enable/disable |

### Cron Jobs
| Method | Path | Description |
|---|---|---|
| GET | `/api/cron` | List all jobs |
| POST | `/api/cron` | Create job |
| PUT | `/api/cron/:name` | Update job |
| POST | `/api/cron/:name/toggle` | Enable/disable |
| POST | `/api/cron/:name/trigger` | Manual trigger |
| DELETE | `/api/cron/:name` | Delete job |

### Mood & Emotion
| Method | Path | Description |
|---|---|---|
| GET | `/api/mood` | Current mood state |
| POST | `/api/mood` | Set/reclassify mood |
| GET | `/api/emotion` | Current 8D emotion vector |

### Knowledge Base
| Method | Path | Description |
|---|---|---|
| GET | `/api/knowledge` | KB stats |
| POST | `/api/knowledge/sync` | Trigger sync |
| GET | `/api/knowledge/files/:fileId/chunks` | File chunks |
| DELETE | `/api/knowledge/files/:fileId` | Remove file |

### Quests (Supabase)
| Method | Path | Description |
|---|---|---|
| POST | `/api/quests` | Create quest |
| GET | `/api/quests` | List quests |
| PUT | `/api/quests/:questId` | Update quest |
| POST | `/api/quests/:questId/complete` | Complete quest |
| POST | `/api/quests/:questId/favorite` | Toggle favorite |
| DELETE | `/api/quests/:questId` | Delete quest |

### Linear
| Method | Path | Description |
|---|---|---|
| GET | `/api/linear/teams` | List teams |
| GET | `/api/linear/projects` | List projects |
| GET | `/api/linear/issues` | List issues |
| GET | `/api/linear/issues/me` | My issues |
| GET | `/api/linear/issues/:id` | Issue detail |
| POST | `/api/linear/issues` | Create issue |
| PATCH | `/api/linear/issues/:id` | Update issue |
| DELETE | `/api/linear/issues/:id` | Delete issue |
| POST | `/api/linear/issues/:id/comments` | Add comment |
| GET | `/api/linear/search` | Search issues |
| POST | `/api/linear/projects` | Create project |

### System
| Method | Path | Description |
|---|---|---|
| POST | `/api/reboot` | Graceful restart |
| GET | `/api/logs` | Recent log entries |
| GET | `/api/logs/stream` | Live log SSE stream |
| GET | `/api/supabase/status` | Supabase connectivity |

### WebSocket (`/ws`)

Connect with `Authorization: Bearer <key>` header. Server negotiates `permessage-deflate` automatically when `web.wsCompression: true` (the default).

**Client messages:**
- `{type: "init", sessionId, userId?, username?}` - Initialize session
- `{type: "message", content}` - Send message (streaming response)
- `{type: "clear"}` - Clear session
- `{type: "presence", status}` - Presence update
- `{type: "subscribe", topics: string[], binary?: boolean}` - Narrow this client's event feed to the listed topics. Optional `binary: true` (for `emotion`) sends `Float32Array` frames instead of JSON when `web.wsBinaryEmotion: true`.
- `{type: "unsubscribe", topics: string[]}` - Remove topics from this client's feed.

**Server messages:**
- `{type: "ready", sessionId}` - Session ready
- `{type: "token", content}` - Stream token
- `{type: "done", reply}` - Response complete
- `{type: "error", error}` - Error
- `{type: "event", event, data}` - Broadcast event, routed by topic (mood/emotion → `emotion`, `tokens:usage` → `tokens`, conversation graph → `mindmap`, console → `logs`)
- `{type: "subscribed", topics: string[]}` - Ack for subscribe/unsubscribe

**Topics:** `chat`, `emotion`, `mindmap`, `logs`, `tokens`, `heartbeat`. Clients that never send `subscribe` receive every topic (backward-compat default).

</details>

---

<details>
<summary><strong>Project Structure</strong></summary>

```text
src/
|-- index.ts                    # Startup orchestration
|-- boot.ts                     # Process wrapper (auto-restart)
|-- config.ts                   # YAML config + Zod validation
|-- async-write-queue.ts        # Debounced/coalesced async file writes
|-- llm.ts                      # LLM client, history, streaming, tool loop, prompt-cache key derivation, TTFT timing
|-- llm/http-client.ts          # Undici global dispatcher (HTTP/2 + keepalive) + connection counters
|-- persona.ts                  # Persona file discovery and composition
|-- tool-registry.ts            # Tool auto-discovery and execution
|-- agent-registry.ts           # Agent auto-discovery and execution
|-- cron.ts                     # Cron scheduler
|-- sessions.ts                 # Session tracking and persistence
|-- memory.ts                   # Fact store with semantic search + ranked injection
|-- fact-extractor.ts           # 12-category extraction with contradiction detection
|-- message-triage.ts           # Pre-response async triage (dates, entities, sentiment)
|-- user-profile.ts             # Per-user LLM-synthesized profile dossiers
|-- token-tracker.ts            # Centralized token usage tracking
|-- vector-store.ts             # Vectra semantic search
|-- knowledge-base.ts           # Google Drive knowledge base
|-- emotion-vector.ts           # Continuous 8D emotion vectors
|-- mood.ts                     # Plutchik emotion classification
|-- logger.ts                   # Console capture + SSE/WS topic-routed broadcast
|-- web.ts                      # Express dashboard + REST API (+ /api/llm/transport diagnostics)
|-- ws.ts                       # WebSocket chat server, topic subscriptions, permessage-deflate
|-- heartbeat.ts                # Periodic handler system
|-- users.ts                    # User profile store
|-- supabase.ts                 # Supabase client singleton
|-- tools/                      # Runtime tool modules
|-- agents/                     # Sub-agent modules
|-- llm/                        # LLM runtime abstraction (chat/responses)
|-- discord/                    # Discord client, commands, attachments
`-- ambient/                    # Ambient awareness engine

data/                           # Runtime data (gitignored)
  |-- memory.json               # Fact store
  |-- users.json                # User profiles
  |-- users/                    # Per-user profile markdown files
  |-- token-usage.json          # Token usage stats
  |-- vectors/                  # Vectra index
  `-- ...                       # Sessions, logs, cron state, etc.

persona/                        # Persona markdown files
settings.yaml                   # Your config (gitignored)
settings.example.yaml           # Config template
openapi.yaml                    # REST API spec
```

</details>

---

<details>
<summary><strong>Scripts</strong></summary>

| Command | Description |
|---|---|
| `npm run dev` | Start with tsx (TypeScript direct execution + auto-restart) |
| `npm run dev:watch` | Start with file watching (no boot wrapper) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run lint` | Type-check without emitting build artifacts |
| `npm run test` | Run unit tests |
| `npm run check` | Full validation (`build && lint && test`) |
| `npm start` | Run compiled production build |

</details>

---

<details>
<summary><strong>Further Reading</strong></summary>

- [ARCHITECTURE.md](ARCHITECTURE.md) - Deep technical reference
- [openapi.yaml](openapi.yaml) - REST API spec (also at `/api/docs` when running)

</details>

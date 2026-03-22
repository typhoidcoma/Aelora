# Aelora

<p align="center">
  <img src="assets/aelora_art_04.png" alt="Aelora" width="320" />
</p>

**The embodiment layer of the Luminora Emotion Engine.**

Aelora is an LLM-powered Discord bot built as part of the Aeveon creative universe. It connects to any OpenAI-compatible API, has a composable personality system (Persona), and supports modular tools, agents, scheduled tasks, proactive heartbeat actions, a scoring and gamification engine, and a live web dashboard.

---

<details>
<summary><strong>Features</strong></summary>

- **LLM Chat** - Any OpenAI-compatible endpoint (OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio)
- **Streaming** - Token-by-token streaming to Discord, dashboard, and WebSocket clients
- **Persona System** - Composable personality from layered markdown files with hot-reload
- **Tool Framework** - Drop a `.ts` file in `src/tools/`, it auto-loads with typed params and config resolution
- **Agent Framework** - Sub-agents with their own system prompts, tool allowlists, and reasoning loops
- **Memory** - Per-user and per-channel fact storage with enriched metadata (category, confidence, source), semantic search via vector embeddings (Vectra + OpenAI), auto-extraction with contradiction detection, weighted ranking (semantic relevance + recency + access frequency), periodic consolidation of related facts, and automatic personality profile synthesis
- **Web Search** - Configurable provider (Brave or OpenAI Responses API)
- **Google Tasks** - Full task management: list, create, complete, update, delete
- **Google Calendar** - Full calendar CRUD with event reminders via heartbeat
- **Gmail** - Read, send, search, label, and trash messages
- **Google Docs** - Read, create, append, search documents
- **Knowledge Base** - Sync a Google Drive folder to the vector index; files (Docs, PDFs, text, Sheets, images) are chunked, embedded, and auto-searched on every message
- **Linear** - Issue tracking and project management (issues CRUD, projects, teams, search, comments, GraphQL)
- **Scoring System** - Science-backed 0-100 task scoring with XP, streaks, achievements, and adaptive per-user learning (see below)
- **Notes** - Persistent notes scoped to channels or global
- **Date Resolution** - Natural language date parsing (chrono-node) for accurate scheduling ("next Friday", "in 2 hours")
- **Cron Jobs** - Scheduled messages (static or LLM-generated) with timezone support, silent mode, runtime CRUD
- **Sessions** - Conversation tracking with metadata, persisted to disk
- **Daily Log** - Automatic daily activity logging
- **User Profiles** - Per-user tracking across channels with detail overlay and cascading delete
- **Image Generation** - DALL-E 3 or compatible API via the luminizer tool (text-to-image with configurable style prompts)
- **Heartbeat** - Periodic handlers for calendar reminders, task sync, memory compaction, fact consolidation, data cleanup, knowledge base sync
- **Discord Activity** - Embedded Unity WebGL or web app in Discord voice channels via `/play`
- **Mood System** - Plutchik's wheel emotion tracking (8 emotions x 3 intensities), auto-classified per response, manual set/reclassify via API
- **Data Export** - JSON bundle of all bot data via API or dashboard
- **File Logging** - Optional daily log files with automatic rotation
- **Config Validation** - Zod-powered schema validation with clear startup errors
- **Lite Mode** - Slim tool schemas and trimmed prompts for local models (4B-7B)
- **WebSocket Chat** - Bidirectional chat over `/ws` for Unity or game clients
- **Security Hardening (Compat Mode)** - Bearer-first auth with deprecated query-token fallback and sensitive-route protection
- **Web Dashboard** - 7-tab layout (Home, Persona, Data, People, Automation, System, Mindmap) with at-a-glance stat cards, achievements, calendar, scoring, live console, real-time LLM conversation visualization, and full data management
- **Auto-Restart** - Process wrapper with graceful reboot via exit code signal
- **Async Persistence Queue** - Debounced/coalesced async writes with bounded flush and graceful shutdown draining
- **Connection Guards** - SSE/WS client caps and payload-size limits for stream/export endpoints
- **Configurable Timezone** - Global IANA timezone for cron, logs, and date formatting

</details>

---

<details>
<summary><strong>Quick Start</strong></summary>

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An LLM API key (OpenAI, or any compatible provider)
- A [Supabase](https://supabase.com/) project (free tier) for scoring persistence

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
| `supabase` | Supabase project URL and anon key for scoring persistence |
| `agents` | Agent system toggle, max iterations |
| `heartbeat` | Periodic handler system interval (default: 15 min) |
| `memory` | Max facts per scope, max fact length, TTL, vector search, embedding config, consolidation |
| `logger` | SSE buffer size, file logging toggle, log file retention |
| `cron` | Max execution history records per job |
| `web` | Dashboard toggle, port, apiKey, basePath (reverse proxy prefix), auth compatibility flags, sensitive-route policy |
| `activity` | Discord Activity toggle, client ID/secret, server URL |
| `knowledge` | Google Drive knowledge base: folder ID, sync interval, chunk size, relevance threshold |

</details>

---

<details>
<summary><strong>Scoring System</strong></summary>

Aelora scores every task on a 0-100 scale and awards XP on completion. The system is fully automatic: each Discord user gets their own Google Calendar (auto-created on first use), calendar events sync every 15 minutes with LLM-powered metadata enrichment, scores update continuously, and streaks and achievements are tracked without any user input required.

### Score Formula

```
Total (0-100) = Urgency (0-35) + Impact (0-30) + Effort (0-20) + Context (0-15)
```

**Urgency** uses exponential temporal decay based on hyperbolic discounting. Tasks with no deadline score 18 (neutral). Overdue tasks score 35 (max). Tasks due soon spike sharply:

| Time until due | Urgency |
|---|---|
| Overdue | 35 |
| 1 hour | 34.5 |
| 12 hours | 30 |
| 1 day | 25 |
| 3 days | 16 |
| 7 days | 7 |
| None | 18 |

**Impact** scores the consequence of NOT doing the task:

| Level | Score | Example |
|---|---|---|
| trivial | 5 | Reorganize a shelf |
| low | 10 | Non-urgent email |
| moderate | 17 | Grocery run |
| high | 24 | Pay a bill |
| critical | 30 | Surgery, tax deadline |

+6 if irreversible (window can't be recovered), +3 if it affects others. Capped at 30.

**Effort** uses the SMEQ scale (Subjective Mental Effort Questionnaire, Zijlstra 1993) which measures cognitive load on 0-150. Lower cognitive effort scores higher in this dimension (WSJF throughput logic):

```
effortScore = max(1, round(20 * (1 - smeq / 150)))
```

Filing taxes (SMEQ ~110) scores 5. A quick errand (SMEQ ~25) scores 17. This correctly reflects that mentally exhausting tasks should be deprioritized relative to equally urgent but lighter tasks, unless urgency or impact force the issue.

**Context** adapts to each user: category bias from historical completion patterns, streak bonus (up to 5 points for 30-day streaks), and momentum from recent completions.

### XP and Achievements

```
XP = round(basePoints * streakMultiplier * overdueBonus)
basePoints = 10 + (score / 100) * 90
streakMultiplier = 1 + min(streak, 30) / 30   (1.0x to 2.0x)
overdueBonus = 1.25 if task was overdue, else 1.0
```

**9 achievements:** First Task, 10 Tasks, 100 Tasks, 3-Day Streak, 7-Day Streak, 30-Day Streak, 1000 XP, High Scorer (90+ score), Overdue Hero.

### Adaptive Learning

After enough completions in a category, the system builds a personal baseline using exponential moving averages (alpha=0.2). Tasks in categories you find easy score higher in the effort dimension; tasks in categories you struggle with score lower, accurately reflecting individual cognitive profiles.

### Discord Commands

```
@Aelora show my leaderboard
@Aelora what are my stats
@Aelora show achievements
```

### Supabase Setup

1. Create a free project at [supabase.com](https://supabase.com/)
2. Run all migrations in order in the SQL editor:
  - [supabase/migrations/001_scoring_system.sql](supabase/migrations/001_scoring_system.sql) - Core scoring tables
  - [supabase/migrations/002_add_linear_source.sql](supabase/migrations/002_add_linear_source.sql) - Linear source type
  - [supabase/migrations/003_user_task_lists.sql](supabase/migrations/003_user_task_lists.sql) - Per-user task lists
  - [supabase/migrations/004_user_calendar.sql](supabase/migrations/004_user_calendar.sql) - Per-user calendar mapping
3. Disable RLS on all 5 scoring tables (this is a private bot with server-side auth):

```sql
ALTER TABLE user_profiles  DISABLE ROW LEVEL SECURITY;
ALTER TABLE life_events     DISABLE ROW LEVEL SECURITY;
ALTER TABLE scoring_events  DISABLE ROW LEVEL SECURITY;
ALTER TABLE category_stats  DISABLE ROW LEVEL SECURITY;
ALTER TABLE achievements    DISABLE ROW LEVEL SECURITY;
```

4. Add to `settings.yaml`:

```yaml
supabase:
  url: "https://your-project.supabase.co"
  anonKey: "your-anon-key"
```

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

The bot syncs every 30 minutes by default. Relevant excerpts appear automatically in responses as a "Reference Material" section in the active persona's context. All config options (sync interval, chunk size, overlap, max chunks per prompt, min relevance score) are documented in `settings.example.yaml`.

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

### Directory Structure

```
persona/
â”œâ”€â”€ _shared/
â”‚   â”œâ”€â”€ bootstrap.md            # Shared response format and rules (order 5)
â”‚   â””â”€â”€ lore.md                 # Shared Lumie lore and Covenant (order 6)
â”œâ”€â”€ aelora/
â”‚   â”œâ”€â”€ soul.md                 # Behavioral core (order 10)
â”‚   â”œâ”€â”€ execution.md            # Execution protocol (order 15)
â”‚   â”œâ”€â”€ skills.md               # Character skills (order 50)
â”‚   â”œâ”€â”€ tools.md                # Tool usage and scoring instructions (order 80)
â”‚   â””â”€â”€ templates/user.md       # Per-user preferences
â”œâ”€â”€ wendy/
â”‚   â”œâ”€â”€ soul.md                 # Behavioral core (order 10)
â”‚   â”œâ”€â”€ backstory.md            # Wendy-specific lore anchors (order 12)
â”‚   â”œâ”€â”€ skills.md               # Character skills (order 50)
â”‚   â””â”€â”€ tools.md                # Tool usage instructions (order 80)
â”œâ”€â”€ arlo/                       # soul, skills, tools, templates
â”œâ”€â”€ tyler/                      # soul, skills, tools
â””â”€â”€ patyna/
    â”œâ”€â”€ bootstrap.md            # Overrides _shared/bootstrap.md (ambient presence)
    â”œâ”€â”€ soul.md
    â”œâ”€â”€ skills.md
    â””â”€â”€ tools.md
```

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

`text` goes to the LLM; `data` is returned in REST API responses as structured JSON. Plain strings work too. Files prefixed with `_` are skipped.

### Adding an Agent

Create a file in `src/agents/`:

```typescript
import type { Agent } from "./types.js";

const agent: Agent = {
  definition: {
    name: "researcher",
    description: "Researches a topic using available tools.",
    systemPrompt: "You are a research assistant.",
    tools: ["*"],
    maxIterations: 5,
  },
  enabled: true,
};

export default agent;
```

Three agents are included: `researcher` (web research with synthesis and note saving), `sprint-planner` (sprint planning), and `standup` (standup reports).

</details>

---

<details>
<summary><strong>Slash Commands</strong></summary>

| Command | Description |
|---|---|
| `/ask [prompt]` | Ask the bot with a rich embed response |
| `/tools` | List all tools and agents with status |
| `/ping` | Latency check |
| `/new` | Start a fresh session (clears history and context) |
| `/websearch [query] [count]` | Search the web (Brave or OpenAI, 1-10 results) |
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
<summary><strong>Discord Activity</strong></summary>

Host a Unity WebGL build (or any web app) as an embedded Discord Activity in voice channels.

### Setup

1. Enable **Activities** in the [Discord Developer Portal](https://discord.com/developers/applications)
2. Under **Activities > URL Mappings**, add: `/` maps to your server URL (Tailscale Funnel or cloudflared tunnel)
3. Add to `settings.yaml`:

```yaml
activity:
  enabled: true
  clientId: "YOUR_APPLICATION_ID"
  clientSecret: "YOUR_CLIENT_SECRET"
  serverUrl: "https://your-tunnel.example.com"
```

4. Place Unity WebGL build files in `activity/Build/`
5. Use `/play` in a voice channel to launch

### How It Works

```
Discord Activity iframe -> activity/index.html (wrapper)
  -> Discord SDK init + OAuth2 handshake
  -> POST /.proxy/api/activity/token (code-to-token exchange)
  -> Unity WebGL loads from /.proxy/activity/Build/*
  -> window.discordBridge <-> Unity SendMessage()
```

Unity C# scripts access Discord context via a `.jslib` plugin:
- `discordBridge.getUser()` - JSON with Discord user info (id, username, globalName, avatar)
- `discordBridge.getContext()` - JSON with guildId, channelId, instanceId

Pre-compressed (gzip) build files are served with correct `Content-Encoding` headers.

</details>

---

<details>
<summary><strong>Web Dashboard</strong></summary>

Access at `http://localhost:3000` (configurable via `web.port`). When Activity is enabled, the dashboard is at `/dashboard`.

For internet-facing deployments, set `web.apiKey` and use `Authorization: Bearer <key>`. Query-token auth (`?token=`) remains available for compatibility but is deprecated and can be disabled via `web.auth.allowQueryToken` / `web.auth.allowWsQueryToken`.

When `web.apiKey` is not configured, public routes stay open and sensitive routes are restricted to local requests only (for example `/api/reboot`, `/api/export`, and persona file mutation endpoints).

- **Status** - Discord connection, uptime, guild count, heartbeat
- **Persona** - Character switching, file editor, prompt size, hot-reload
- **LLM Test** - Send test prompts with streaming output
- **Sessions** - Active conversations, session detail overlay, clear/delete
- **Memory** - Facts by scope, delete individual or clear scopes
- **Tasks** - Per-user Google Tasks with score badges, sort by score/due/priority, XP stats bar
- **Scheduled Tasks** - Create, edit, toggle, trigger cron jobs with execution history
- **Tools** - Enable/disable tools at runtime
- **Agents** - Enable/disable agents at runtime
- **Notes** - Create, edit, delete scoped notes
- **Users** - Profile table with detail overlay, facts viewer, cascading delete
- **Export** - JSON export of all bot data
- **Activity Preview** - Test Unity WebGL build locally
- **Mood** - Live emotion indicator via SSE, manual set/reclassify
- **Console** - Live log stream via SSE

</details>

---

<details>
<summary><strong>Project Structure</strong></summary>

```text
src/
|-- index.ts                    # Startup orchestration
|-- boot.ts                     # Process wrapper (auto-restart)
|-- config.ts                   # YAML config + Zod validation
|-- async-write-queue.ts        # Debounced/coalesced async file writes + flush control
|-- llm.ts                      # LLM client, history, streaming, tool loop
|-- persona.ts                  # Persona file discovery and composition
|-- tool-registry.ts            # Tool auto-discovery and execution
|-- agent-registry.ts           # Agent auto-discovery and execution
|-- cron.ts                     # Cron scheduler with cached state + queued persistence
|-- sessions.ts                 # Session tracking and persistence
|-- memory.ts                   # Fact store with semantic search + ranked injection
|-- logger.ts                   # Console capture + SSE/WS broadcast + bounded clients
|-- web.ts                      # Express dashboard + REST API
|-- ws.ts                       # WebSocket chat server (bearer-first auth)
|-- heartbeat.ts                # Periodic handler system with startup jitter
|-- heartbeat-reply-check.ts    # Missed reply detection with fetch budgets/timeouts
|-- lifecycle.ts                # Graceful reboot
|-- tools/                      # Runtime tool modules
`-- agents/                     # Sub-agent modules

data/                           # Runtime data (gitignored)
settings.yaml                   # Your config (gitignored)
settings.example.yaml           # Config template
openapi.yaml                    # REST API spec
start.bat                       # Windows launcher
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
| `npm run test` | Run scoring engine unit tests |
| `npm run check` | Full validation (`build && lint && test`) |
| `npm start` | Run compiled production build |

</details>

---

<details>
<summary><strong>Further Reading</strong></summary>

- [ARCHITECTURE.md](ARCHITECTURE.md) - Deep technical reference
- [ROADMAP.md](ROADMAP.md) - Planned features and specs
- [openapi.yaml](openapi.yaml) - REST API spec (also at `/api/docs` when running)

</details>


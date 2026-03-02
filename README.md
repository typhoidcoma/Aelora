# Aelora

**The embodiment layer of the Luminora Emotion Engine.**

Aelora is an LLM-powered Discord bot built as part of the Aeveon creative universe. It connects to any OpenAI-compatible API, has a composable personality system (Persona), and supports modular tools, agents, scheduled tasks, proactive heartbeat actions, a scoring and gamification engine, and a live web dashboard.

## Features

- **LLM Chat** - Any OpenAI-compatible endpoint (OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio)
- **Streaming** - Token-by-token streaming to Discord, dashboard, and WebSocket clients
- **Persona System** - Composable personality from layered markdown files with hot-reload
- **Tool Framework** - Drop a `.ts` file in `src/tools/`, it auto-loads with typed params and config resolution
- **Agent Framework** - Sub-agents with their own system prompts, tool allowlists, and reasoning loops
- **Memory** - Per-user and per-channel fact storage, auto-injected into the system prompt
- **Web Search** - Brave Search API integration
- **Google Tasks** - Full task management: list, create, complete, update, delete
- **Google Calendar** - Full calendar CRUD with event reminders via heartbeat
- **Gmail** - Read, send, search, label, and trash messages
- **Google Docs** - Read, create, append, search documents
- **Scoring System** - Science-backed 0-100 task scoring with XP, streaks, achievements, and adaptive per-user learning (see below)
- **Notes** - Persistent notes scoped to channels or global
- **Cron Jobs** - Scheduled messages (static or LLM-generated) with timezone support, silent mode, runtime CRUD
- **Sessions** - Conversation tracking with metadata, persisted to disk
- **Daily Log** - Automatic daily activity logging
- **User Profiles** - Per-user tracking across channels with detail overlay and cascading delete
- **Heartbeat** - Periodic handlers for calendar reminders, task sync, memory compaction, data cleanup
- **Discord Activity** - Embedded Unity WebGL or web app in Discord voice channels via `/play`
- **Mood System** - Plutchik's wheel emotion tracking (8 emotions x 3 intensities), auto-classified per response
- **Data Export** - JSON bundle of all bot data via API or dashboard
- **File Logging** - Optional daily log files with automatic rotation
- **Config Validation** - Zod-powered schema validation with clear startup errors
- **Lite Mode** - Slim tool schemas and trimmed prompts for local models (4B-7B)
- **WebSocket Chat** - Bidirectional chat over `/ws` for Unity or game clients
- **Web Dashboard** - Status, personas, tools, agents, sessions, memory, users, notes, todos, scoring leaderboard, cron, console, mood, export
- **Auto-Restart** - Process wrapper with graceful reboot via exit code signal
- **Configurable Timezone** - Global IANA timezone for cron, logs, and date formatting

## Quick Start

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

## Configuration

All configuration lives in `settings.yaml`. See [settings.example.yaml](settings.example.yaml) for the full reference.

| Section | What it controls |
|---|---|
| `timezone` | IANA timezone for the server (cron, logs, date formatting) |
| `discord` | Bot token, response mode (mention/all), allowed channels, DMs, status |
| `llm` | API endpoint, model, max tokens, conversation history length, lite mode |
| `persona` | Personality system toggle, directory, bot name, active persona |
| `tools` | Per-tool config (API keys, Google OAuth credentials, etc.) |
| `supabase` | Supabase project URL and anon key for scoring persistence |
| `agents` | Agent system toggle, max iterations |
| `heartbeat` | Periodic handler system interval |
| `memory` | Max facts per scope, max fact length, TTL for auto-pruning |
| `logger` | SSE buffer size, file logging toggle, log file retention |
| `cron` | Max execution history records per job |
| `web` | Dashboard toggle and port |
| `activity` | Discord Activity toggle, client ID/secret, server URL |

## Scoring System

Aelora scores every task on a 0-100 scale and awards XP on completion. The system is fully automatic: tasks sync from Google Tasks every 5 minutes, scores update continuously, and streaks and achievements are tracked without any user input required.

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
2. Run [supabase/migrations/001_scoring_system.sql](supabase/migrations/001_scoring_system.sql) in the SQL editor
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

## Google Workspace Setup

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

## Persona System

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
├── _shared/
│   └── bootstrap.md            # Shared response format and rules (order 5)
├── aelora/
│   ├── soul.md                 # Behavioral core (order 10)
│   ├── skills.md               # Character skills (order 50)
│   ├── tools.md                # Tool usage and scoring instructions (order 80)
│   └── templates/user.md       # Per-user preferences
├── wendy/
├── arlo/
└── batperson/
    ├── bootstrap.md            # Overrides _shared/bootstrap.md
    ├── soul.md
    └── skills.md
```

## Tools and Agents

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

A `researcher` agent is included. It searches the web, synthesizes findings, and saves results as notes.

## Slash Commands

| Command | Description |
|---|---|
| `/ask [prompt]` | Ask the bot with a rich embed response |
| `/tools` | List all tools and agents with status |
| `/ping` | Latency check |
| `/new` | Start a fresh session (clears history and context) |
| `/websearch [query] [count]` | Search the web via Brave Search (1-10 results) |
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

## Discord Activity

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

## Web Dashboard

Access at `http://localhost:3000` (configurable via `web.port`). When Activity is enabled, the dashboard is at `/dashboard`.

- **Status** - Discord connection, uptime, guild count, heartbeat
- **Persona** - Character switching, file editor, prompt size, hot-reload
- **LLM Test** - Send test prompts with streaming output
- **Sessions** - Active conversations, session detail overlay, clear/delete
- **Memory** - Facts by scope, delete individual or clear scopes
- **Todos** - Google Tasks with score badges, sort by score/due/priority, XP stats bar
- **Scheduled Tasks** - Create, edit, toggle, trigger cron jobs with execution history
- **Tools** - Enable/disable tools at runtime
- **Agents** - Enable/disable agents at runtime
- **Notes** - Create, edit, delete scoped notes
- **Users** - Profile table with detail overlay, facts viewer, cascading delete
- **Export** - JSON export of all bot data
- **Activity Preview** - Test Unity WebGL build locally
- **Mood** - Live emotion indicator via SSE
- **Console** - Live log stream via SSE

## Project Structure

```
src/
├── index.ts                    # Startup orchestration
├── boot.ts                     # Process wrapper (auto-restart)
├── config.ts                   # YAML config + Zod validation
├── llm.ts                      # LLM client, history, streaming, tool loop
├── persona.ts                  # Persona file discovery and composition
├── tool-registry.ts            # Tool auto-discovery and execution
├── agent-registry.ts           # Agent auto-discovery and execution
├── scoring.ts                  # Pure scoring engine (no I/O)
├── supabase.ts                 # Supabase client singleton and typed helpers
├── cron.ts                     # Cron scheduler (file-based, atomic writes)
├── sessions.ts                 # Session tracking and persistence
├── memory.ts                   # Per-user/channel fact store
├── daily-log.ts                # Daily activity logging
├── users.ts                    # User profile tracking
├── mood.ts                     # Emotion state (Plutchik's wheel)
├── web.ts                      # Express dashboard + REST API
├── ws.ts                       # WebSocket chat server
├── heartbeat.ts                # Periodic handler system
├── heartbeat-calendar.ts       # Google Calendar reminders
├── heartbeat-scoring-sync.ts   # Google Tasks -> Supabase sync (every 5 min)
├── heartbeat-memory.ts         # Memory compaction
├── heartbeat-cleanup.ts        # Data pruning
├── heartbeat-reply-check.ts    # Missed reply detection
├── heartbeat-alive.ts          # Status channel heartbeat
├── heartbeat-conversations.ts  # Conversation persistence
├── state.ts                    # Persisted bot state
├── lifecycle.ts                # Graceful reboot
├── logger.ts                   # Console capture + SSE/WS broadcast + file logging
├── utils.ts                    # Shared utilities
├── tools/
│   ├── types.ts                # defineTool(), param builders
│   ├── scoring.ts              # Scoring viewer tool (stats, leaderboard, achievements)
│   ├── todo.ts                 # Google Tasks adapter
│   ├── google-calendar.ts      # Google Calendar CRUD
│   ├── gmail.ts                # Gmail operations
│   ├── google-tasks.ts         # Google Tasks full CRUD
│   ├── google-docs.ts          # Google Docs read/write/search
│   ├── _google-auth.ts         # Shared OAuth2 helpers (skipped on load)
│   ├── brave-search.ts         # Brave Search
│   ├── cron.ts                 # Cron job management
│   ├── memory.ts               # Memory save/list/forget
│   ├── mood.ts                 # Emotion override
│   ├── notes.ts                # Persistent notes
│   ├── ping.ts                 # Test tool
│   └── _example-*.ts           # Example templates (skipped on load)
└── agents/
    ├── types.ts                # Agent type definitions
    └── researcher.ts           # Web research agent

supabase/
└── migrations/
    └── 001_scoring_system.sql  # DB schema (user_profiles, life_events, scoring_events, category_stats, achievements)

activity/                       # Discord Activity (Unity WebGL)
persona/                        # Personality files
public/                         # Dashboard frontend (HTML/JS/CSS)
data/                           # Runtime data (gitignored)
settings.yaml                   # Your config (gitignored)
settings.example.yaml           # Config template
openapi.yaml                    # REST API spec
start.bat                       # Windows launcher
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with tsx (TypeScript direct execution + auto-restart) |
| `npm run dev:watch` | Start with file watching (no boot wrapper) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |

## Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) - Deep technical reference
- [ROADMAP.md](ROADMAP.md) - Planned features and specs
- [openapi.yaml](openapi.yaml) - REST API spec (also at `/api/docs` when running)

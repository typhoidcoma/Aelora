# Aelora 🦋

**The embodiment layer of the Luminora Emotion Engine.**

Aelora is an LLM-powered Discord bot built as part of the Aeveon creative universe. It connects to any OpenAI-compatible API, has a composable personality system ("Persona"), and supports modular tools, agents, scheduled tasks, proactive heartbeat actions, and a live web dashboard.

## Features

- **LLM Chat** - Any OpenAI-compatible endpoint (OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio)
- **Streaming** - Token-by-token streaming to Discord, dashboard, and WebSocket clients
- **Persona System** - Composable personality from layered markdown files with hot-reload
- **Tool Framework** - Drop a `.ts` file in `src/tools/`, it auto-loads with typed params and config resolution
- **Agent Framework** - Sub-agents with their own system prompts, tool allowlists, and reasoning loops
- **Memory** - Per-user and per-channel fact storage, auto-injected into the system prompt
- **Web Search** - Brave Search API integration
- **CalDAV Calendar** - Full CRUD for calendar events via CalDAV (Radicale)
- **CalDAV Todos** - Task management via CalDAV VTODO, syncs with any CalDAV client
- **Notes** - Persistent notes scoped to channels or global
- **Cron Jobs** - Scheduled messages (static or LLM-generated) with timezone support, silent mode, runtime CRUD
- **Sessions** - Conversation tracking with metadata, persisted to disk
- **Daily Log** - Automatic daily activity logging
- **User Profiles** - Per-user tracking across channels with detail overlay and cascading delete
- **Heartbeat** - Periodic handlers for calendar reminders, memory compaction, data cleanup
- **Discord Activity** - Embedded Unity WebGL or web app in Discord voice channels via `/play`
- **Mood System** - Plutchik's wheel emotion tracking (8 emotions x 3 intensities), auto-classified per response
- **Data Export** - JSON bundle of all bot data via API or dashboard
- **File Logging** - Optional daily log files with automatic rotation
- **Config Validation** - Zod-powered schema validation with clear startup errors
- **Lite Mode** - Slim tool schemas and trimmed prompts for local models (4B-7B)
- **WebSocket Chat** - Bidirectional chat over `/ws` for Unity or game clients
- **Web Dashboard** - Status, personas, tools, agents, sessions, memory, users, notes, todos, cron, console, mood, export
- **Auto-Restart** - Process wrapper with graceful reboot via exit code signal
- **Configurable Timezone** - Global IANA timezone for cron, logs, and date formatting

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Python 3](https://python.org/) (for Radicale CalDAV server)
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An LLM API key (OpenAI, or any compatible provider)

### Setup

```bash
# Clone the repository
git clone <your-repo-url>
cd aelora

# Install dependencies
npm install

# Create your config
cp settings.example.yaml settings.yaml
# Edit settings.yaml with your Discord token, LLM API key, etc.

# Start in development mode
npm run dev
```

### CalDAV Server (Radicale)

The calendar and todo tools require a [Radicale](https://radicale.org/) CalDAV server:

```bash
# Install Radicale
pip install radicale passlib bcrypt

# Generate credentials (from the project root)
python -c "from passlib.hash import bcrypt; print('aelora:' + bcrypt.hash('aelora123'))" > radicale-users

# Start the server
python -m radicale --config radicale-config
```

On first run, open `http://127.0.0.1:5232`, log in, and create a calendar named **"Aelora"** (matching `calendarName` in `settings.yaml`).

Radicale stores data in `data/radicale/` and must be running alongside Aelora for calendar/todo features to work.

### Invite the Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application → OAuth2 → URL Generator
3. Scopes: `bot`, `applications.commands`
4. Permissions: `Send Messages`, `Read Message History`, `Embed Links`, `Attach Files`
5. Copy the generated URL and open it to invite the bot to your server

## Configuration

All configuration lives in `settings.yaml`. See [settings.example.yaml](settings.example.yaml) for the full reference with comments.

| Section | What it controls |
|---|---|
| `timezone` | IANA timezone for the server (cron, logs, date formatting). Defaults to UTC |
| `discord` | Bot token, response mode (mention/all), allowed channels, DMs, status |
| `llm` | API endpoint, model, max tokens, conversation history length, lite mode |
| `persona` | Personality system toggle, directory, bot name, active persona |
| `tools` | Per-tool config (API keys, CalDAV credentials, etc.) |
| `agents` | Agent system toggle, max iterations |
| `heartbeat` | Periodic handler system interval |
| `memory` | Max facts per scope, max fact length, TTL for auto-pruning |
| `logger` | SSE buffer size, file logging toggle, log file retention |
| `cron` | Max execution history records per job |
| `web` | Dashboard toggle and port |
| `activity` | Discord Activity toggle, client ID/secret, server URL |

## Persona System

Aelora's personality is composed from markdown files in the `persona/` directory. Each file has YAML frontmatter controlling load order, enable/disable, and section labels:

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

Files are sorted by `order`, concatenated, and injected as the system prompt. Variables like `{{botName}}` are substituted from config. Persona files can be hot-reloaded from the web dashboard without restarting the bot.

### Shared + Per-Persona Architecture

The persona system uses a **shared inheritance** model:

- **`_shared/`** - Files shared across all personas (e.g. `bootstrap.md`). Loaded first.
- **Per-persona directories** - Each persona's own files (soul, skills, tools). Same-name files override shared ones.

```
persona/
├── _shared/
│   └── bootstrap.md            # Shared response format + rules (order 5)
├── aelora/
│   ├── soul.md                 # Behavioral core (order 10)
│   ├── skills.md               # Character skills (order 50)
│   ├── tools.md                # Tool usage instructions (order 80)
│   └── templates/user.md       # Per-user preferences (placeholder)
├── wendy/                      # soul.md, skills.md, tools.md, templates/
├── arlo/                       # soul.md, skills.md, tools.md, templates/
└── batperson/
    ├── bootstrap.md            # Overrides _shared/bootstrap.md
    ├── soul.md
    └── skills.md
```

Each persona's `soul.md` frontmatter includes `botName`, which gets substituted into `{{botName}}` across all files.

## Tools & Agents

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
      text: `Processed: ${input}`,          // shown to the LLM
      data: { input, processedAt: new Date().toISOString() },  // returned via REST API
    };
  },
});
```

Handlers return `{ text, data }`. The `text` goes to the LLM, `data` is included as structured JSON in REST API responses. Plain strings still work.

Tools prefixed with `_` are skipped (use for examples/templates).

### Adding an Agent

Create a file in `src/agents/` with an `AgentDefinition`:

```typescript
import type { Agent } from "./types.js";

const agent: Agent = {
  definition: {
    name: "researcher",
    description: "Researches a topic using available tools.",
    systemPrompt: "You are a research assistant. Use tools to find information.",
    tools: ["*"],        // all tools, or ["notes", "calendar"] for specific ones
    maxIterations: 5,
  },
  enabled: true,
};

export default agent;
```

A `researcher` agent is included out of the box. It searches the web, synthesizes findings, and optionally saves results as notes.

For more details, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Slash Commands

| Command | Description |
|---------|-------------|
| `/ask [prompt]` | Ask the bot with a rich embed response |
| `/tools` | List all tools and agents with status |
| `/ping` | Latency check |
| `/new` | Start a fresh session (clears history, summary, and context) |
| `/websearch [query] [count]` | Search the web via Brave Search (1-10 results) |
| `/memory view` | View your remembered facts |
| `/memory add [fact]` | Remember a fact about you |
| `/memory clear` | Clear all your remembered facts |
| `/mood` | Show the bot's current emotional state |
| `/note list [scope]` | List notes in a scope |
| `/note get [scope] [title]` | Read a note |
| `/note save [scope] [title] [content]` | Create or update a note |
| `/note delete [scope] [title]` | Delete a note |
| `/help` | List all available commands |
| `/reboot` | Graceful restart |
| `/play` | Launch the Discord Activity in a voice channel |

## Google Workspace Setup

The Gmail, Google Calendar, Google Docs, and Google Tasks tools all use OAuth2 with a refresh token. You need a Google Cloud project with the appropriate APIs enabled.

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable these APIs under **APIs & Services > Library**:
   - Gmail API
   - Google Calendar API
   - Google Docs API
   - Google Tasks API
   - Google Drive API (used by Docs search)

### 2. Create OAuth2 Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Application type: **Web application**
4. Under **Authorized redirect URIs**, add: `https://developers.google.com/oauthplayground`
5. Copy the **Client ID** and **Client Secret**

### 3. Generate a Refresh Token

1. Go to [Google OAuth Playground](https://developers.google.com/oauthplayground/)
2. Click the gear icon (Settings) in the top right
3. Check **Use your own OAuth credentials**
4. Enter your Client ID and Client Secret
5. In the left panel, select these scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/drive.readonly`
6. Click **Authorize APIs** and complete the consent flow
7. Click **Exchange authorization code for tokens**
8. Copy the **Refresh Token**

### 4. Add to Settings

```yaml
tools:
  google:
    clientId: "your-client-id.apps.googleusercontent.com"
    clientSecret: "your-client-secret"
    refreshToken: "1//your-refresh-token"
```

## Discord Activity

Host a Unity WebGL build (or any web app) as an embedded [Discord Activity](https://discord.com/developers/docs/activities/overview) in Discord voice channels.

### Setup

1. Enable **Activities** in the [Discord Developer Portal](https://discord.com/developers/applications) for your application
2. Under **Activities > URL Mappings**, add a prefix mapping: `/` → your server URL (e.g. a Tailscale Funnel or cloudflared tunnel)
3. Copy your **Application ID** and **OAuth2 Client Secret** to `settings.yaml`:

```yaml
activity:
  enabled: true
  clientId: "YOUR_APPLICATION_ID"
  clientSecret: "YOUR_CLIENT_SECRET"
  serverUrl: "https://your-tunnel.example.com"  # optional, for direct file loading
```

4. Place your Unity WebGL build files in the `activity/Build/` directory
5. Use `/play` in Discord to launch the Activity from a voice channel

### How It Works

```
Discord Activity iframe → activity/index.html (wrapper)
  ↓ Discord SDK init + OAuth2 handshake
  ↓ POST /.proxy/api/activity/token → Express (code→token exchange)
  ↓ Loads Unity WebGL build from /.proxy/activity/Build/*
  ↓ Bridge: window.discordBridge ↔ Unity SendMessage()
```

The wrapper page handles the full Discord SDK lifecycle (init, authorize, authenticate), loads Unity, and exposes a `window.discordBridge` object for Unity C# ↔ JavaScript interop. All requests from inside the Activity iframe go through Discord's `/.proxy/` prefix.

Pre-compressed (gzip) build files are served with appropriate `Content-Encoding` headers for efficient loading through Discord's proxy.

### Unity ↔ Discord Bridge

Unity C# scripts can call into JavaScript via a `.jslib` plugin:

- `discordBridge.getUser()` → JSON with Discord user info (id, username, globalName, avatar)
- `discordBridge.getContext()` → JSON with guildId, channelId, instanceId

Once both the SDK and Unity are ready, the wrapper sends `OnDiscordReady` to Unity via `SendMessage("DiscordManager", "OnDiscordReady", jsonData)`.

## Web Dashboard

Access at `http://localhost:3000` (configurable via `web.port`). When Activity is enabled, the dashboard moves to `/dashboard`. For remote access, see [Deployment](deploy/DEPLOY.md#6-remote-access-with-tailscale).

- **Status** - Discord connection, uptime, guild count, heartbeat
- **Persona** - Character switching, file editor, prompt size, hot-reload
- **LLM Test** - Send test prompts with streaming output
- **Sessions** - Active conversations, session detail overlay, clear/delete
- **Memory** - Facts by scope, delete individual or clear scopes
- **Scheduled Tasks** - Create, edit, toggle, trigger cron jobs with execution history
- **Tools** - Enable/disable tools at runtime
- **Agents** - Enable/disable agents at runtime, view tool allowlists
- **Notes** - Create, edit, delete scoped notes
- **Todos** - CalDAV-backed tasks with priority, due dates, completion
- **Users** - Profile table with detail overlay, facts viewer, cascading delete
- **Export** - JSON export of all bot data
- **Activity Preview** - Test Unity WebGL build locally without Discord
- **Mood** - Live emotion indicator, auto-updated via SSE
- **Console** - Live log stream via SSE

## Project Structure

```
src/
├── index.ts                 # Startup orchestration
├── boot.ts                  # Process wrapper (auto-restart)
├── config.ts                # YAML config + Zod validation
├── llm.ts                   # LLM client, history, streaming, tool loop
├── persona.ts               # Persona file discovery + composition
├── tool-registry.ts         # Tool auto-discovery + execution
├── agent-registry.ts        # Agent auto-discovery + execution
├── cron.ts                  # Cron scheduler (file-based, atomic writes)
├── sessions.ts              # Session tracking + persistence
├── memory.ts                # Per-user/channel fact store
├── daily-log.ts             # Daily activity logging
├── users.ts                 # User profile tracking
├── mood.ts                  # Emotion state (Plutchik's wheel)
├── web.ts                   # Express dashboard + REST API
├── ws.ts                    # WebSocket chat server
├── heartbeat.ts             # Periodic handler system
├── heartbeat-*.ts           # Calendar, memory, cleanup, reply-check, alive, conversations
├── state.ts                 # Persisted bot state
├── lifecycle.ts             # Graceful reboot
├── logger.ts                # Console capture + SSE/WS broadcast + file logging
├── utils.ts                 # Shared utilities
├── discord/
│   ├── client.ts            # Message routing, streaming
│   ├── commands.ts          # Slash commands
│   ├── attachments.ts       # Image vision + text file processing
│   └── embeds.ts            # Embed builders
├── tools/
│   ├── types.ts             # defineTool(), param builders
│   ├── ping.ts              # Test tool
│   ├── notes.ts             # Persistent notes
│   ├── calendar.ts          # CalDAV calendar CRUD
│   ├── todo.ts              # CalDAV task management
│   ├── brave-search.ts      # Brave Search
│   ├── cron.ts              # Cron job management
│   ├── memory.ts            # Memory save/list/forget
│   ├── mood.ts              # Emotion override
│   ├── gmail.ts             # Gmail operations
│   ├── google-calendar.ts   # Google Calendar
│   ├── google-docs.ts       # Google Docs
│   ├── google-tasks.ts      # Google Tasks
│   ├── _google-auth.ts      # Shared OAuth2 (skipped on load)
│   └── _example-*.ts        # Example templates (skipped on load)
└── agents/
    ├── types.ts             # Agent type definitions
    └── researcher.ts        # Web research agent

activity/                    # Discord Activity (Unity WebGL)
persona/                     # Personality files
public/                      # Dashboard frontend (HTML/JS/CSS)
data/                        # Runtime data (gitignored)
settings.yaml                # Your config (gitignored)
settings.example.yaml        # Config template
openapi.yaml                 # REST API spec
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

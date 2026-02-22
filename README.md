# Aelora 🦋

**The embodiment layer of the Luminora Emotion Engine.**

Aelora is an LLM-powered Discord bot built as part of the Aeveon creative universe. It connects to any OpenAI-compatible API, has a composable personality system ("Persona"), and supports modular tools, agents, scheduled tasks, proactive heartbeat actions, and a live web dashboard.

## Features

- **LLM Chat** — Works with any OpenAI-compatible endpoint (OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio)
- **Streaming Responses** — Token-by-token streaming to Discord messages and the dashboard LLM test
- **Persona System** — Composable personality built from layered markdown files with shared bootstrap, per-character souls, switchable personas, and hot-reload
- **Tool Framework** — Drop a `.ts` file in `src/tools/`, it auto-loads. Typed params, config resolution, runtime toggle
- **Agent Framework** — Sub-agents with their own system prompts, tool allowlists, and reasoning loops
- **Memory** — Persistent per-user and per-channel fact storage, automatically injected into the system prompt
- **Web Search** — Brave Search API integration for real-time web queries
- **CalDAV Calendar** — Full CRUD for any CalDAV server (Radicale, Nextcloud, Baikal, iCloud)
- **Notes** — Persistent note storage scoped to channels or global
- **Cron Jobs** — Scheduled messages (static text or LLM-generated) with timezone support, file-based persistence, runtime CRUD
- **Sessions** — Conversation session tracking with metadata, persisted to disk
- **Daily Log** — Automatic daily activity logging
- **Heartbeat** — Periodic handler system for proactive actions (calendar reminders, memory compaction)
- **Discord Activity** — Host a Unity WebGL build (or any web app) as an embedded Discord Activity with OAuth2, SDK integration, and a `/play` command
- **Web Dashboard** — Real-time status, tool/agent management, live console, LLM testing, Activity preview
- **Auto-Restart** — Process wrapper with graceful reboot via exit code signal
- **Configurable Timezone** — Global IANA timezone setting for cron, logs, and date formatting

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
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
| `llm` | API endpoint, model, max tokens, conversation history length |
| `persona` | Personality system toggle, directory, bot name, active persona |
| `tools` | Per-tool config (API keys, CalDAV credentials, etc.) |
| `agents` | Agent system toggle, max iterations |
| `heartbeat` | Periodic handler system interval |
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

- **`_shared/`** — Files shared across all personas (e.g. `bootstrap.md` for response format rules). Loaded first.
- **Per-persona directories** — Each persona's own files (soul, skills, tools). If a persona has a file with the same basename as a shared file, the persona's version overrides the shared one.

```
persona/
├── _shared/
│   └── bootstrap.md            — Shared response format & operating rules (order 5)
├── aelora/
│   ├── soul.md                 — Aelora's behavioral core (order 10, botName: "Aelora")
│   ├── skills.md               — Character skills (order 50)
│   ├── tools.md                — Tool usage instructions (order 80)
│   └── templates/
│       └── user.md             — Per-user preferences (disabled, placeholder)
├── wendy/
│   ├── soul.md                 — Wendy's behavioral core (order 10, botName: "Wendy")
│   ├── skills.md
│   ├── tools.md
│   └── templates/user.md
├── arlo/
│   ├── soul.md                 — Arlo's behavioral core (order 10, botName: "Arlo")
│   ├── skills.md
│   ├── tools.md
│   └── templates/user.md
└── batperson/
    ├── bootstrap.md            — Overrides _shared/bootstrap.md for BatPerson
    ├── soul.md                 — BatPerson's behavioral core (order 10, botName: "BatPerson")
    └── skills.md
```

Each persona's `soul.md` frontmatter includes `botName` — the character's display name. This gets substituted into `{{botName}}` across all files.

## Tools & Agents

### Adding a Tool

Create a file in `src/tools/` — it auto-loads on startup:

```typescript
import { defineTool, param } from "./types.js";

export default defineTool({
  name: "my-tool",
  description: "Does something useful.",
  params: {
    input: param.string("The input to process.", { required: true }),
  },
  handler: async (args, ctx) => {
    return `Processed: ${args.input}`;
  },
});
```

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

A `researcher` agent is included out of the box — it searches the web, synthesizes findings, and optionally saves results as notes.

For more details, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Discord Activity

Host a Unity WebGL build (or any web app) as an embedded [Discord Activity](https://discord.com/developers/docs/activities/overview) — a full-screen interactive app that runs inside Discord voice channels.

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

Access at `http://localhost:3000` (configurable via `web.port`). When Activity is enabled, the dashboard moves to `/dashboard`. For remote access, use Tailscale Funnel or Serve — see [Deployment: Remote Access](deploy/DEPLOY.md#6-remote-access-with-tailscale).

- **Status** — Discord connection, uptime, guild count, heartbeat
- **Persona** — Character switching (card grid), file editor, botName, prompt size, hot-reload
- **LLM Test** — Send test prompts with streaming output
- **Sessions** — Active conversations, message counts, session detail overlay, clear/delete
- **Memory** — Stored facts by scope, delete individual facts or clear scopes
- **Scheduled Tasks** — Create, edit, delete, trigger, toggle cron jobs; human-readable schedules, last/next run, execution history
- **Tools** — Enable/disable tools at runtime
- **Activity Preview** — Test Unity WebGL build locally without Discord (stub user data)
- **Console** — Live log stream via SSE

## Project Structure

```
├── src/
│   ├── index.ts              — Startup orchestration (10-step boot)
│   ├── boot.ts               — Process wrapper (auto-restart on exit 100)
│   ├── config.ts             — YAML config loader + types
│   ├── llm.ts                — LLM client, conversation history, streaming, tool loop
│   ├── persona.ts            — Persona file discovery, parsing, composition
│   ├── tool-registry.ts      — Tool auto-discovery + execution
│   ├── agent-registry.ts     — Agent auto-discovery + execution
│   ├── cron.ts               — Cron job scheduler (file-based persistence, atomic writes)
│   ├── sessions.ts           — Conversation session tracking + persistence
│   ├── memory.ts             — Per-user/channel fact memory store
│   ├── daily-log.ts          — Daily activity logging
│   ├── heartbeat.ts          — Periodic handler system
│   ├── heartbeat-calendar.ts — Calendar reminder handler
│   ├── heartbeat-memory.ts   — Memory compaction handler
│   ├── web.ts                — Express dashboard + REST API
│   ├── lifecycle.ts          — Graceful reboot
│   ├── logger.ts             — Console capture + SSE broadcast
│   ├── utils.ts              — Shared utilities
│   ├── discord.ts            — Discord barrel export
│   ├── discord/
│   │   ├── client.ts         — Discord.js client, message routing, streaming
│   │   ├── commands.ts       — Slash commands (/ask, /tools, /ping, /clear, /websearch, /reboot, /play)
│   │   ├── attachments.ts    — Image vision + text file processing
│   │   └── embeds.ts         — Embed builders
│   ├── tools/
│   │   ├── types.ts          — Tool type system, defineTool(), param builders
│   │   ├── ping.ts           — Test tool
│   │   ├── notes.ts          — Persistent note storage
│   │   ├── calendar.ts       — CalDAV calendar CRUD
│   │   ├── brave-search.ts   — Brave Search web queries
│   │   ├── cron.ts           — Runtime cron job management
│   │   ├── memory.ts         — Memory save/list/forget tool
│   │   ├── _example-gmail.ts — Example tool template (skipped on load)
│   │   └── _example-multi-action.ts — Multi-action tool template
│   └── agents/
│       ├── types.ts          — Agent type definitions
│       └── researcher.ts     — Web research agent (search + synthesize)
├── activity/                 — Discord Activity wrapper + Unity WebGL build
│   ├── index.html            — Discord SDK + OAuth2 + Unity loader
│   ├── test.html             — Local test page (no Discord SDK)
│   └── Build/                — Unity WebGL build files (.gz compressed)
├── persona/                  — Personality files (see Persona System above)
├── public/                   — Web dashboard frontend
│   ├── index.html
│   ├── app.js
│   └── style.css
├── assets/                   — Static assets (bot graphics, etc.)
├── data/                     — Runtime data (gitignored)
├── settings.yaml             — Your config (gitignored)
├── settings.example.yaml     — Config template
├── openapi.yaml              — OpenAPI 3.1 spec for the REST API
├── package.json
└── tsconfig.json
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with tsx (TypeScript direct execution + auto-restart) |
| `npm run dev:watch` | Start with file watching (no boot wrapper) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |

## Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — Deep technical reference for all systems
- [ROADMAP.md](ROADMAP.md) — Planned features and specs
- [openapi.yaml](openapi.yaml) — REST API specification (also available at `/api/docs` when the bot is running)

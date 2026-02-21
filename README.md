# Aelora

**The embodiment layer of the Luminora Emotion Engine.**

Aelora is an LLM-powered Discord bot built as part of the Aeveon creative universe. It connects to any OpenAI-compatible API, has a composable personality system ("Persona"), and supports modular tools, agents, scheduled tasks, proactive heartbeat actions, and a live web dashboard — all from a single `settings.yaml` config file.

## Features

- **LLM Chat** — Works with any OpenAI-compatible endpoint (OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio)
- **Streaming Responses** — Token-by-token streaming to Discord messages and the dashboard LLM test
- **Persona System** — Composable personality built from layered markdown files with switchable modes and hot-reload
- **Tool Framework** — Drop a `.ts` file in `src/tools/`, it auto-loads. Typed params, config resolution, runtime toggle
- **Agent Framework** — Sub-agents with their own system prompts, tool allowlists, and reasoning loops
- **Memory** — Persistent per-user and per-channel fact storage, automatically injected into the system prompt
- **Web Search** — Brave Search API integration for real-time web queries
- **CalDAV Calendar** — Full CRUD for any CalDAV server (Radicale, Nextcloud, Baikal, iCloud)
- **Notes** — Persistent note storage scoped to channels or global
- **Cron Jobs** — Scheduled messages (static text or LLM-generated) with timezone support, runtime CRUD
- **Sessions** — Conversation session tracking with metadata, persisted to disk
- **Heartbeat** — Periodic handler system for proactive actions (e.g. calendar reminders)
- **Discord Activity** — Host a Unity WebGL build (or any web app) as an embedded Discord Activity with OAuth2, SDK integration, and a `/play` command
- **Web Dashboard** — Real-time status, tool/agent management, live console, LLM testing, Activity preview
- **Auto-Restart** — Process wrapper with graceful reboot via exit code signal

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
| `discord` | Bot token, response mode (mention/all), allowed channels, DMs, status |
| `llm` | API endpoint, model, max tokens, conversation history length |
| `persona` | Personality system toggle, directory, bot name, active persona |
| `tools` | Per-tool config (API keys, CalDAV credentials, etc.) |
| `agents` | Agent system toggle, max iterations |
| `cron` | Scheduled jobs (static messages or LLM-generated) |
| `heartbeat` | Periodic handler system interval |
| `web` | Dashboard toggle and port |
| `activity` | Discord Activity toggle, client ID/secret, server URL |

## Persona System

Aelora's personality is composed from markdown files in the `persona/` directory. Each file has YAML frontmatter controlling load order, enable/disable, and section labels:

```markdown
---
order: 10
enabled: true
label: "Identity"
section: identity
---

# Identity

You are **{{botName}}**, the embodiment layer of the Luminora Emotion Engine...
```

Files are sorted by `order`, concatenated, and injected as the system prompt. Variables like `{{botName}}` are substituted from config. Persona files can be hot-reloaded from the web dashboard without restarting the bot.

### Personas

Each persona is a **self-contained character** — a distinct named entity with its own identity, backstory, personality, bootstrap rules, and skills. Each persona lives in its own directory under `persona/`. The active persona is set via `persona.activePersona` in `settings.yaml`. Each persona's `persona.md` frontmatter includes a `botName` field — the character's display name — which is substituted into `{{botName}}` across all files.

**Current persona structure:**

```
persona/
├── aelora/
│   ├── persona.md            — Persona manifest (order 90, botName: "Aelora")
│   ├── bootstrap.md          — Response format, behavioral rules (order 5)
│   ├── identity.md           — Character identity & backstory (order 10)
│   ├── soul.md               — Behavioral core (order 20)
│   ├── skills.md             — Character skills & competencies (order 50)
│   ├── tools.md              — Tool/agent usage instructions (order 80)
│   └── templates/
│       └── user.md           — Per-user preferences (disabled, placeholder)
├── wendy/
│   └── (same structure — separate character, botName: "Wendy")
└── batperson/
    └── (same structure — separate character, botName: "Batperson")
```

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

Access at `http://localhost:3000` (configurable via `web.port`). When Activity is enabled, the dashboard moves to `/dashboard`.

- **Status** — Discord connection, uptime, guild count
- **Persona** — Character persona switching (card grid), file editor, botName, prompt size, hot-reload
- **Tools & Agents** — Enable/disable at runtime
- **Sessions** — Active conversations, message counts, clear/delete
- **Memory** — Stored facts by scope, delete individual facts or clear scopes
- **Cron** — Create, edit, delete, trigger, toggle jobs; schedules, last/next run, errors
- **Heartbeat** — Tick count, handler list
- **LLM Test** — Send test prompts with streaming output
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
│   ├── cron.ts               — Cron job scheduler + runtime CRUD
│   ├── sessions.ts           — Conversation session tracking + persistence
│   ├── memory.ts             — Per-user/channel fact memory store
│   ├── heartbeat.ts          — Periodic handler system
│   ├── heartbeat-calendar.ts — Calendar reminder handler
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
│   │   └── _example-gmail.ts — Example tool template (skipped on load)
│   └── agents/
│       └── types.ts          — Agent type definitions
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

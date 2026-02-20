# Aelora

**The embodiment layer of the Luminora Emotion Engine.**

Aelora is an LLM-powered Discord bot built as part of the [Aeveon](https://github.com/your-org/aeveon) creative universe. It connects to any OpenAI-compatible API, has a composable personality system ("Persona"), and supports modular tools, agents, scheduled tasks, proactive heartbeat actions, and a live web dashboard — all from a single `settings.yaml` config file.

## Features

- **LLM Chat** — Works with any OpenAI-compatible endpoint (OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio)
- **Persona System** — Composable personality built from layered markdown files with switchable modes and hot-reload
- **Tool Framework** — Drop a `.ts` file in `src/tools/`, it auto-loads. Typed params, config resolution, runtime toggle
- **Agent Framework** — Sub-agents with their own system prompts, tool allowlists, and reasoning loops
- **CalDAV Calendar** — Full CRUD for any CalDAV server (Radicale, Nextcloud, Baikal, iCloud)
- **Notes** — Persistent note storage scoped to channels or global
- **Cron Jobs** — Scheduled messages (static text or LLM-generated) with timezone support
- **Heartbeat** — Periodic handler system for proactive actions (e.g. calendar reminders)
- **Web Dashboard** — Real-time status, tool/agent management, live console, LLM testing
- **Auto-Restart** — Process wrapper with graceful reboot via exit code signal

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An LLM API key (OpenAI, or any compatible provider)

### Setup

```bash
# Clone the repository
git clone https://github.com/your-org/aelora.git
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
| `persona` | Personality system toggle, directory, bot name, active mode |
| `tools` | Per-tool config (API keys, CalDAV credentials, etc.) |
| `agents` | Agent system toggle, max iterations |
| `cron` | Scheduled jobs (static messages or LLM-generated) |
| `heartbeat` | Periodic handler system interval |
| `web` | Dashboard toggle and port |

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

### Modes

Each persona mode is a folder under `persona/modes/`. The active mode is set via `persona.activeMode` in `settings.yaml`. Shared files (identity, skills, tools, etc.) are always loaded; only the active mode's folder is included. Each mode has its own `mode.md` (persona description) and `soul.md` (behavioral core).

**Current persona structure:**

```
persona/
├── bootstrap.md              — Response format, behavioral rules, safety (order 5)
├── identity.md               — Who Aelora is (order 10)
├── skills/
│   ├── creative-writing.md   — Prose craft rules (order 50)
│   └── worldbuilding.md      — World design rules (order 51)
├── tools.md                  — Tool/agent usage instructions (order 80)
├── modes/
│   ├── default/
│   │   ├── mode.md           — Default persona (order 90)
│   │   └── soul.md           — Default behavioral core (order 20)
│   ├── storyteller/
│   │   ├── mode.md           — Narrative persona (order 90)
│   │   └── soul.md           — Storyteller behavioral core (order 20)
│   └── worldbuilder/
│       ├── mode.md           — Lore-building persona (order 90)
│       └── soul.md           — Worldbuilder behavioral core (order 20)
└── templates/
    └── user.md               — Per-user preferences (disabled, placeholder)
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

## Web Dashboard

Access at `http://localhost:3000` (configurable via `web.port`).

- **Status** — Discord connection, uptime, guild count
- **Persona** — File inventory, active mode, prompt size, hot-reload button
- **Tools & Agents** — Enable/disable at runtime
- **Cron** — Job schedules, last/next run, errors
- **Heartbeat** — Tick count, handler list
- **LLM Test** — Send test prompts with current persona config
- **Console** — Live log stream via SSE

## Project Structure

```
├── src/
│   ├── index.ts              — Startup orchestration (10-step boot)
│   ├── boot.ts               — Process wrapper (auto-restart on exit 100)
│   ├── config.ts             — YAML config loader + types
│   ├── llm.ts                — LLM client, conversation history, tool loop
│   ├── persona.ts            — Persona file discovery, parsing, composition
│   ├── tool-registry.ts      — Tool auto-discovery + execution
│   ├── agent-registry.ts     — Agent auto-discovery + execution
│   ├── cron.ts               — Cron job scheduler
│   ├── heartbeat.ts          — Periodic handler system
│   ├── heartbeat-calendar.ts — Calendar reminder handler
│   ├── web.ts                — Express dashboard + REST API
│   ├── lifecycle.ts          — Graceful reboot
│   ├── logger.ts             — Console capture + SSE broadcast
│   ├── utils.ts              — Shared utilities
│   ├── discord.ts            — Discord barrel export
│   ├── discord/
│   │   ├── client.ts         — Discord.js client, message routing
│   │   ├── commands.ts       — Slash commands (/ask, /tools, /ping, /reboot)
│   │   ├── attachments.ts    — Image vision + text file processing
│   │   └── embeds.ts         — Embed builders
│   ├── tools/
│   │   ├── types.ts          — Tool type system, defineTool(), param builders
│   │   ├── ping.ts           — Test tool
│   │   ├── notes.ts          — Persistent note storage
│   │   └── calendar.ts       — CalDAV calendar CRUD
│   └── agents/
│       └── types.ts          — Agent type definitions
├── persona/                  — Personality files (see Persona System above)
├── public/                   — Web dashboard frontend
│   ├── index.html
│   ├── app.js
│   └── style.css
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

# Roadmap

Planned features for Aelora 🦋. Each feature includes an overview, how it integrates with existing systems, proposed data models, and an implementation sketch.

---

## 1. Quests

### Overview

Interactive multi-step missions that Aelora can assign, track, and mark complete. Users receive quests (creative writing prompts, worldbuilding tasks, community challenges), submit work, get feedback, and progress through quest chains. Designed to encourage engagement within the Aeveon creative universe.

### How It Fits

| System | Role |
|--------|------|
| **Tool** | `quest` tool — accept, submit, check progress, list active/completed quests |
| **Agent** | `quest-master` agent — evaluates submissions using LLM judgment, gives feedback |
| **Heartbeat** | Deadline reminders for active quests, nudges for stale quests |
| **Persona** | Quest-related persona or skill file for tone when assigning/reviewing |
| **Notes** | Fallback persistence if quest store is unavailable |

### Data Model

```
data/quests.json
{
  "definitions": {
    "quest-id": {
      "id": "quest-id",
      "title": "The First Dawn",
      "description": "Write 500 words describing a sunrise in the Aeveon universe.",
      "type": "creative-writing",       // creative-writing, worldbuilding, community
      "difficulty": "beginner",          // beginner, intermediate, advanced
      "requirements": {
        "wordCount": 500,
        "tags": ["aeveon", "scene"]
      },
      "reward": "Lorekeeper I",          // Badge or title
      "chainNext": "quest-id-2",         // Next quest in chain (optional)
      "createdAt": "ISO timestamp"
    }
  },
  "progress": {
    "userId": {
      "quest-id": {
        "status": "in_progress",         // available, in_progress, submitted, completed, failed
        "acceptedAt": "ISO timestamp",
        "submittedAt": null,
        "completedAt": null,
        "submission": null,
        "feedback": null,
        "deadline": "ISO timestamp"      // Optional
      }
    }
  }
}
```

### Implementation Sketch

**Tool (`src/tools/quest.ts`):**
- Actions: `list-available`, `accept`, `submit`, `status`, `history`
- `list-available` — returns quests the user hasn't completed
- `accept` — moves quest to `in_progress` for user, sets optional deadline
- `submit` — stores submission text, triggers agent evaluation
- `status` — shows active quests and progress
- `history` — completed quests with feedback

**Agent (`src/agents/quest-master.ts`):**
- System prompt: "You are a quest evaluator. Review the submission against the quest requirements. Give specific feedback and a pass/fail judgment."
- Tools: `["quest"]` (to update quest state)
- Called automatically on submission, or manually ("review my quest")
- `postProcess()` extracts pass/fail decision and feedback text

**Heartbeat handler:**
- Check for quests approaching deadline → send reminder
- Check for quests stale >7 days → send gentle nudge

**Estimated complexity:** Medium-high. ~300 lines tool + ~50 lines agent + ~40 lines heartbeat handler.

---

## 2. Storytelling Engine

### Overview

Collaborative interactive fiction with persistent narrative state. Users can start story sessions, make choices, and collaborate on branching narratives. Aelora narrates scenes, manages NPCs, and maintains continuity across sessions. Ties directly into Aelora's existing roleplay and creative writing skills.

### How It Fits

| System | Role |
|--------|------|
| **Tool** | `story` tool — start, continue, save, load, list sessions |
| **Agent** | `narrator` agent — dedicated storytelling agent with world context |
| **Persona** | `storyteller/` persona (switch via `persona.activePersona`) |
| **Cron** | Optional "story recap" scheduled messages for ongoing sessions |

### Data Model

```
data/stories/
├── {channel-id}/
│   ├── session.json         — Active session state
│   └── archive/
│       └── {session-id}.json — Completed/saved sessions

session.json:
{
  "id": "uuid",
  "title": "The Wanderer's Path",
  "channelId": "channel-id",
  "createdAt": "ISO timestamp",
  "lastActivity": "ISO timestamp",
  "genre": "fantasy",
  "setting": "The northern reaches of Aeveon...",
  "characters": {
    "npc-id": {
      "name": "Kaelen",
      "role": "guide",
      "description": "A weathered traveler...",
      "disposition": "cautious"
    }
  },
  "scenes": [
    {
      "index": 0,
      "narration": "The path ahead splits...",
      "playerAction": "I take the left fork",
      "timestamp": "ISO timestamp"
    }
  ],
  "state": {
    "location": "Crossroads",
    "mood": "tense",
    "flags": ["met_kaelen", "found_map"]
  },
  "maxScenes": 50
}
```

### Implementation Sketch

**Tool (`src/tools/story.ts`):**
- Actions: `start`, `continue`, `save`, `load`, `list`, `status`
- `start` — creates session with genre/setting, enables storyteller persona
- `continue` — appends player action, calls narrator agent for next scene
- `save` / `load` — persist and restore sessions
- `status` — current scene, characters, location, mood

**Agent (`src/agents/narrator.ts`):**
- System prompt built from: base narrator instructions + current session state (setting, characters, recent scenes, flags)
- Tools: `["story"]` (to update session state, add characters, set flags)
- Produces narration that advances the scene and presents choices
- `postProcess()` extracts narration text and any state updates

**Persona integration:**
- Switch to storyteller persona (`persona.activePersona: "storyteller"`) when a story session is active
- Switch back to default persona when session ends or is saved

**Estimated complexity:** High. ~400 lines tool + ~80 lines agent + session state management.

---

## 3. Mail System

### Overview

Asynchronous message delivery between users, and from Aelora to users. Users can leave messages for people who are offline — delivered when the recipient next interacts with Aelora. Also supports system mail (quest completions, reminders, announcements).

### How It Fits

| System | Role |
|--------|------|
| **Tool** | `mail` tool — send, inbox, read, delete |
| **Heartbeat** | Check for undelivered mail when users become active |
| **Cron** | Scheduled announcements or digest summaries |

### Data Model

```
data/mail.json
{
  "userId": {
    "inbox": [
      {
        "id": "uuid",
        "from": "userId" | "system",
        "subject": "Meeting tomorrow",
        "body": "Don't forget about the guild meeting...",
        "sentAt": "ISO timestamp",
        "readAt": null,
        "delivered": false,
        "channel": "channel-id"       // Where to deliver notification
      }
    ]
  }
}
```

### Implementation Sketch

**Tool (`src/tools/mail.ts`):**
- Actions: `send`, `inbox`, `read`, `delete`
- `send` — store message in recipient's inbox
- `inbox` — list unread/all messages for the calling user
- `read` — mark as read, return full message
- `delete` — remove from inbox

**Delivery mechanism (heartbeat handler):**
- On each tick, check if any users with undelivered mail have been recently active (based on Discord presence or recent messages)
- When recipient is detected: send a DM or channel mention: "You have 2 new messages. Say 'check mail' to read them."
- Mark as `delivered: true`

**Alternative: message handler hook:**
- On every incoming Discord message, check if the user has unread mail
- If so, append a note to the LLM response context: "This user has 3 unread messages"
- Aelora can then naturally mention it in conversation

**Estimated complexity:** Low-medium. ~150 lines tool + ~30 lines heartbeat handler.

---

## 4. Voice Integration

### Overview

Join Discord voice channels to speak (TTS) and listen (STT). Aelora can narrate stories aloud, read calendar events, participate in voice conversations, or simply provide ambient presence with occasional commentary.

### How It Fits

| System | Role |
|--------|------|
| **Tool** | `voice` tool — join, leave, speak, set voice settings |
| **Discord** | Voice connection via @discordjs/voice |
| **LLM** | STT transcription → LLM → TTS response pipeline |

### Dependencies

```
npm install @discordjs/voice @discordjs/opus
# System: ffmpeg must be installed and in PATH
```

External APIs:
- **TTS**: OpenAI TTS (`tts-1`), ElevenLabs, or local (Piper)
- **STT**: OpenAI Whisper (`whisper-1`), or local (faster-whisper)

### Data Model

```typescript
type VoiceSession = {
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  listening: boolean;           // Whether STT is active
  voiceId: string;              // TTS voice/model
  speakQueue: string[];         // Pending TTS utterances
};
```

No persistent storage needed — voice state is entirely in-memory.

### Implementation Sketch

**Tool (`src/tools/voice.ts`):**
- Actions: `join`, `leave`, `speak`, `configure`
- `join` — connect to the user's current voice channel
- `leave` — disconnect
- `speak` — add text to TTS queue, play audio
- `configure` — set voice model, speed, pitch

**Voice pipeline (`src/voice/`):**
- `src/voice/tts.ts` — text → audio buffer (via OpenAI or ElevenLabs API)
- `src/voice/stt.ts` — audio stream → text (via Whisper API)
- `src/voice/connection.ts` — manage Discord voice connection, audio player, receive streams

**Flow (listen mode):**
```
User speaks → Discord audio stream → STT → text
  → getLLMResponse(channelId, text) → response text
  → TTS → audio buffer → Discord audio player → User hears
```

**Considerations:**
- STT requires receiving audio from Discord (opus decoding, VAD for utterance detection)
- TTS latency is critical — stream audio as it's generated if possible
- Voice activity detection (VAD) to know when a user starts/stops speaking
- Multiple simultaneous speakers need handling

**Estimated complexity:** High. ~200 lines tool + ~300 lines voice pipeline + external API integration.

---

## 5. Image Generation

### Overview

Generate images from text prompts and send them as Discord attachments. Supports AI art for storytelling, worldbuilding illustrations, character portraits, or any creative request.

### How It Fits

| System | Role |
|--------|------|
| **Tool** | `image` tool — generate from prompt, with style/size options |
| **Discord** | Send generated images as message attachments |
| **Persona** | Prompt enhancement — Aelora can refine user prompts before generation |

### Configuration

```yaml
tools:
  image:
    provider: "openai"           # openai, stability, local
    apiKey: "sk-..."
    model: "dall-e-3"            # or "stable-diffusion-xl", etc.
    defaultSize: "1024x1024"
    defaultQuality: "standard"   # standard, hd
```

### Data Model

No persistent storage required. Optionally log generations:

```
data/image-log.json
{
  "generations": [
    {
      "id": "uuid",
      "prompt": "A crystal tower at sunset in Aeveon",
      "revisedPrompt": "A towering crystalline structure...",  // From DALL-E
      "provider": "openai",
      "model": "dall-e-3",
      "size": "1024x1024",
      "url": "https://...",
      "userId": "discord-user-id",
      "channelId": "channel-id",
      "createdAt": "ISO timestamp"
    }
  ]
}
```

### Implementation Sketch

**Tool (`src/tools/image.ts`):**
- Actions: `generate`
- Params: `prompt` (required), `size`, `quality`, `style` (natural/vivid), `count`
- Calls provider API (OpenAI images.generate, Stability API, or local ComfyUI)
- Downloads generated image to temp file
- Returns a message with the image URL/path for Discord to attach

**Discord integration:**
- The tool returns a special marker (e.g. `[IMAGE:path]`) that the message handler detects
- Handler sends the image as a Discord attachment with the prompt as caption
- Alternative: tool calls `sendToChannel()` directly with an attachment

**Provider abstraction:**
```typescript
interface ImageProvider {
  generate(prompt: string, options: ImageOptions): Promise<Buffer>;
}
```

Multiple providers behind a common interface. Selected by config.

**Estimated complexity:** Medium. ~150 lines tool + ~50 lines provider abstraction.

---

## 6. User Profiles

> **Simple Memory (implemented):** A lightweight fact-based memory system is now live as a stepping stone toward full User Profiles. The `memory` tool lets Aelora save/recall/forget short facts scoped per user (`user:<id>`) or per channel (`channel:<id>`). Facts are persisted to `data/memory.json` and automatically injected into the system prompt. The dashboard shows all stored facts with delete/clear controls. Future plans: auto-summarization, vector search, structured preference tracking, relationship context.

### Overview

Per-user memory, preferences, and interaction tracking. Aelora remembers user preferences (communication style, interests, timezone), maintains relationship context, and adapts her responses per user. The existing `persona/aelora/templates/user.md` placeholder supports per-user prompt injection.

### How It Fits

| System | Role |
|--------|------|
| **Tool** | `profile` tool — view, update preferences, clear |
| **Persona** | `templates/user.md` — inject per-user context into system prompt |
| **LLM** | Auto-inject user profile into conversation context |
| **Discord** | Map Discord user IDs to profiles |

### Data Model

```
data/profiles.json
{
  "userId": {
    "displayName": "Tesse",
    "timezone": "America/New_York",
    "preferences": {
      "communicationStyle": "casual",     // casual, formal, playful
      "verbosity": "concise",             // concise, detailed, balanced
      "interests": ["worldbuilding", "fantasy", "programming"],
      "pronouns": "they/them"
    },
    "memory": [
      {
        "key": "current_project",
        "value": "Working on the northern continent lore",
        "setAt": "ISO timestamp"
      }
    ],
    "stats": {
      "firstSeen": "ISO timestamp",
      "lastSeen": "ISO timestamp",
      "messageCount": 142,
      "toolsUsed": ["notes", "calendar", "quest"]
    },
    "notes": "Prefers creative feedback to be direct and specific."
  }
}
```

### Implementation Sketch

**Tool (`src/tools/profile.ts`):**
- Actions: `view`, `set-preference`, `remember`, `forget`, `stats`
- `view` — show the user's profile
- `set-preference` — update communication style, verbosity, timezone, etc.
- `remember` — store a key-value memory ("remember that I'm working on X")
- `forget` — remove a memory
- `stats` — interaction statistics

**System prompt injection:**
- On each `getLLMResponse()`, look up the user's profile by Discord user ID
- If profile exists, append a `## User Context` section to the system prompt:
  ```
  ## User Context
  - Name: Tesse (they/them)
  - Timezone: America/New_York
  - Style: casual, concise
  - Interests: worldbuilding, fantasy, programming
  - Memory: Working on the northern continent lore
  ```
- This requires passing the Discord user ID through to `getLLMResponse()` (currently only channelId is passed)

**Auto-tracking:**
- Increment `messageCount` on each interaction
- Update `lastSeen` timestamp
- Track which tools the user triggers

**Persona template:**
- Enable `persona/templates/user.md` with instructions for how to use user context
- Template guides Aelora on adapting tone, referencing user interests, and respecting preferences

**Estimated complexity:** Medium. ~200 lines tool + ~30 lines LLM injection + user ID plumbing.

---

## 7. Web Search / RAG

### Overview

Real-time web search and document retrieval. Aelora can look up current information, search documentation, or query a local knowledge base. Optionally supports RAG (Retrieval-Augmented Generation) with a vector store for the Aeveon lore corpus.

### How It Fits

| System | Role |
|--------|------|
| **Tool** | `search` tool — web search with result summarization |
| **Tool** | `knowledge` tool (optional) — query vector store for lore/docs |
| **Agent** | `researcher` agent — multi-step research using search + knowledge tools |

### Configuration

```yaml
tools:
  search:
    provider: "searxng"          # searxng, brave, tavily
    baseUrl: "http://localhost:8888"  # SearXNG instance URL
    apiKey: ""                   # For Brave/Tavily
    maxResults: 5

  knowledge:                     # Optional RAG
    provider: "chromadb"         # chromadb, qdrant
    baseUrl: "http://localhost:8000"
    collection: "aeveon-lore"
    embeddingModel: "text-embedding-3-small"
```

### Data Model

**Search:** No persistent storage — results are returned inline.

**Knowledge base (RAG):**
```
Vector store (external):
  Collection: "aeveon-lore"
  Documents: chunked markdown from lore files
  Metadata: { source, section, tags }
  Embeddings: text-embedding-3-small (1536 dims)
```

### Implementation Sketch

**Search tool (`src/tools/search.ts`):**
- Actions: `search`
- Params: `query` (required), `maxResults`
- Calls search provider API (SearXNG JSON API, Brave Search API, or Tavily)
- Returns formatted results: title, URL, snippet for each result
- LLM can then synthesize an answer from the results

**Knowledge tool (`src/tools/knowledge.ts`):**
- Actions: `query`, `ingest`
- `query` — semantic search against vector store, returns relevant document chunks
- `ingest` — add documents to the knowledge base (admin only)
- Uses OpenAI embeddings API for query embedding

**Researcher agent (`src/agents/researcher.ts`):**
- System prompt: "You are a research assistant. Use the search and knowledge tools to find accurate information. Cite your sources."
- Tools: `["search", "knowledge"]`
- Multi-step: search → read results → refine query → synthesize answer

**Provider abstraction:**
```typescript
interface SearchProvider {
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

interface VectorProvider {
  query(text: string, topK: number): Promise<VectorResult[]>;
  ingest(documents: Document[]): Promise<void>;
}
```

**SearXNG setup (self-hosted, recommended):**
```bash
docker run -d -p 8888:8080 searxng/searxng
```

**Estimated complexity:** Medium for search only (~120 lines). High with RAG (~300 lines + vector store setup).

---

## Priority Overview

| Feature | Complexity | Dependencies | Priority |
|---------|-----------|--------------|----------|
| Mail | Low-medium | None | Short-term |
| User Profiles | Medium | Simple memory done; full profiles next | Short-term |
| Quests | Medium-high | Profiles (for per-user progress) | Medium-term |
| Image Generation | Medium | External API key | Medium-term |
| Storytelling Engine | High | Profiles, possibly quests | Medium-term |
| Web Search / RAG | Medium-high | External search API or self-hosted SearXNG | Medium-term |
| Voice Integration | High | ffmpeg, external TTS/STT APIs, @discordjs/voice | Long-term |

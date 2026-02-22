# Roadmap

Planned features for Aelora 🦋. Each feature includes an overview, how it integrates with existing systems, proposed data models, and an implementation sketch.

---

## Already Implemented

These features from prior roadmap versions are now live:

| Feature | Status | Notes |
|---------|--------|-------|
| **Memory System** | Done | Per-user and per-channel fact storage via `memory` tool. Auto-injected into system prompt. Dashboard management. |
| **Web Search** | Done | Brave Search API integration via `brave-search` tool. |
| **Researcher Agent** | Done | Multi-step web research agent with synthesis and note saving (`src/agents/researcher.ts`). |
| **Configurable Timezone** | Done | Global IANA timezone via `settings.yaml`. Affects cron, logs, and date formatting. |

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
    model: "dall-e-3"
    defaultSize: "1024x1024"
    defaultQuality: "standard"   # standard, hd
```

### Implementation Sketch

**Tool (`src/tools/image.ts`):**
- Actions: `generate`
- Params: `prompt` (required), `size`, `quality`, `style` (natural/vivid), `count`
- Calls provider API (OpenAI images.generate, Stability API, or local ComfyUI)
- Downloads generated image to temp file
- Returns a message with the image URL/path for Discord to attach

**Estimated complexity:** Medium. ~150 lines tool + ~50 lines provider abstraction.

---

## 6. User Profiles

### Overview

Per-user memory, preferences, and interaction tracking. Aelora remembers user preferences (communication style, interests, timezone), maintains relationship context, and adapts her responses per user. Builds on the existing memory system with structured preference tracking.

### How It Fits

| System | Role |
|--------|------|
| **Tool** | `profile` tool — view, update preferences, clear |
| **Persona** | `templates/user.md` — inject per-user context into system prompt |
| **LLM** | Auto-inject user profile into conversation context |
| **Memory** | Extends existing memory system with structured data |

### Data Model

```
data/profiles.json
{
  "userId": {
    "displayName": "Tesse",
    "timezone": "America/Chicago",
    "preferences": {
      "communicationStyle": "casual",
      "verbosity": "concise",
      "interests": ["worldbuilding", "fantasy", "programming"],
      "pronouns": "they/them"
    },
    "stats": {
      "firstSeen": "ISO timestamp",
      "lastSeen": "ISO timestamp",
      "messageCount": 142,
      "toolsUsed": ["notes", "calendar", "quest"]
    }
  }
}
```

### Implementation Sketch

**Tool (`src/tools/profile.ts`):**
- Actions: `view`, `set-preference`, `stats`
- `view` — show the user's profile
- `set-preference` — update communication style, verbosity, timezone, etc.
- `stats` — interaction statistics

**System prompt injection:**
- On each `getLLMResponse()`, look up the user's profile
- If profile exists, append a `## User Context` section to the system prompt

**Estimated complexity:** Medium. ~200 lines tool + ~30 lines LLM injection.

---

## Priority Overview

| Feature | Complexity | Dependencies | Priority |
|---------|-----------|--------------|----------|
| Mail | Low-medium | None | Short-term |
| User Profiles | Medium | Extends existing memory | Short-term |
| Quests | Medium-high | Profiles (for per-user progress) | Medium-term |
| Image Generation | Medium | External API key | Medium-term |
| Storytelling Engine | High | Profiles, possibly quests | Medium-term |
| Voice Integration | High | ffmpeg, external TTS/STT APIs, @discordjs/voice | Long-term |

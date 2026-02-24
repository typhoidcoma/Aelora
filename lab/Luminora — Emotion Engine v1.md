# Luminora — Emotion Engine v1
_Plutchik-Based Mood Tracking for AI Personas_

---

## 0. Purpose

The emotion engine gives each persona a persistent emotional state that:

- Shifts naturally based on conversation tone (auto-classified)
- Can be manually overridden by the bot when auto-detection misses a shift
- Is visible on the dashboard in real time (colored indicator + label)
- Gets injected into the system prompt so the persona's responses stay emotionally consistent

This is not sentiment analysis of the *user* — it tracks how the *bot* is feeling.

---

## 1. Theoretical Foundation: Plutchik's Wheel of Emotions

The engine is built on Robert Plutchik's psychoevolutionary theory of emotion (1980). Plutchik's wheel defines **8 primary emotions** arranged in opposing pairs, each with **3 intensity levels** — yielding **24 distinct emotional states**.

### Why Plutchik?

- **Structured and finite.** 8 emotions x 3 intensities = 24 states. LLMs can reliably classify into a small, well-defined set.
- **Intensity is built in.** Instead of just "happy" or "sad", we get a spectrum — serenity → joy → ecstasy. This lets the bot express nuance.
- **Opposing pairs prevent drift.** Joy opposes sadness; trust opposes disgust. The model inherently avoids contradictory states.
- **Blends are meaningful.** Adjacent emotions combine into recognizable compound feelings (joy + trust = love). We support this via the secondary emotion field.

---

## 2. The 24 Emotional States

Each primary emotion has three intensity tiers: **low** (mild/subtle), **mid** (standard), and **high** (intense).

| Primary Emotion | Low | Mid | High |
|-----------------|-----|-----|------|
| **Joy** | Serenity | Joy | Ecstasy |
| **Trust** | Acceptance | Trust | Admiration |
| **Fear** | Apprehension | Fear | Terror |
| **Surprise** | Distraction | Surprise | Amazement |
| **Sadness** | Pensiveness | Sadness | Grief |
| **Disgust** | Boredom | Disgust | Loathing |
| **Anger** | Annoyance | Anger | Rage |
| **Anticipation** | Interest | Anticipation | Vigilance |

### Opposing Pairs

| Pair | Axis |
|------|------|
| Joy ↔ Sadness | Happiness vs sorrow |
| Trust ↔ Disgust | Openness vs rejection |
| Fear ↔ Anger | Retreat vs confrontation |
| Surprise ↔ Anticipation | Unexpected vs expected |

---

## 3. Emotion Blends

Plutchik defines compound emotions as blends of adjacent primaries. The engine supports one optional **secondary emotion** to capture these blends.

### Primary Dyads (adjacent emotion blends)

| Blend | Emotions | Feeling |
|-------|----------|---------|
| Love | Joy + Trust | Warm affection, genuine care |
| Submission | Trust + Fear | Deference, yielding to authority |
| Awe | Fear + Surprise | Overwhelmed wonder |
| Disapproval | Surprise + Sadness | Unexpected disappointment |
| Remorse | Sadness + Disgust | Regretful rejection |
| Contempt | Disgust + Anger | Hostile disdain |
| Aggressiveness | Anger + Anticipation | Assertive drive |
| Optimism | Anticipation + Joy | Hopeful forward energy |

These aren't hardcoded — they emerge naturally when the classifier detects a primary + secondary emotion. The system prompt tells the bot it's feeling "joy with undertones of trust", and the persona interprets that through its own voice.

---

## 4. Dashboard Display

Each emotion has an assigned color for the dashboard indicator:

| Emotion | Color | Hex |
|---------|-------|-----|
| Joy | Gold | `#f2c572` |
| Trust | Green | `#8bc58b` |
| Fear | Purple | `#9b7fbf` |
| Surprise | Teal | `#5fbfbf` |
| Sadness | Blue | `#6a8cb7` |
| Disgust | Olive | `#8b8b6a` |
| Anger | Red | `#c56a6a` |
| Anticipation | Amber | `#d4a056` |

The active persona card shows a colored dot + the specific emotion label (e.g., "Serenity", "Admiration + joy"). Updates push live via Server-Sent Events — no page refresh needed.

---

## 5. How Mood Gets Set

### 5a. Auto-Classification (primary mechanism)

After each bot response in Discord or the web chat:

1. **Throttle check** — skips if mood was updated less than 30 seconds ago (prevents API spam during rapid messages)
2. **Lightweight LLM call** — sends the user's message + bot's response to the classifier with a minimal system prompt
3. **JSON parse** — extracts `{ emotion, intensity, secondary?, note? }`
4. **Validation** — confirms emotion and intensity are valid Plutchik values
5. **Save + broadcast** — persists to disk and pushes to all connected dashboards

The classifier prompt explicitly names all 8 emotions and 3 intensities. It asks for a brief note (max 100 chars) explaining the classification.

### 5b. Manual Override (secondary mechanism)

The bot has a `set_mood` tool it can call to express intentional mood shifts:

- Useful when auto-detection might miss subtle shifts (e.g., the bot decides to adopt a contemplative tone)
- Bypasses the 30-second throttle
- Takes the same parameters: emotion, intensity, optional secondary, optional note

The bot uses this when it *wants* to shift mood, not just when it *happens* to.

---

## 6. System Prompt Integration

The current mood is injected into every LLM request via `buildMoodPromptSection()`:

**When mood is set:**
> You are currently feeling **serenity** with undertones of **trust** — calm helpful exchange.

**When no mood is set yet:**
> No mood set yet — it will be detected automatically from your responses.

This ensures the persona's emotional state influences its responses naturally. The persona doesn't *announce* its mood — it *embodies* it. A persona in "serenity" responds with calm warmth; one in "annoyance" responds with an edge.

---

## 7. Persistence

- **File:** `data/current-mood.json`
- **Survives restarts** — the bot resumes with its last emotional state
- **Single global state** — one mood per bot instance (not per user or per channel)

### Stored fields

```json
{
  "emotion": "joy",
  "intensity": "mid",
  "secondary": "trust",
  "note": "warm helpful exchange",
  "updatedAt": "2026-02-24T12:34:56.789Z"
}
```

---

## 8. Design Decisions

### Why not sentiment analysis of the user?

The emotion engine tracks the *bot's* emotional state, not the user's. The bot is a persona with its own emotional continuity. Tracking the user's emotions would be surveillance; tracking the bot's is characterization.

### Why auto-classify instead of always manual?

Requiring the bot to manually set its mood every message would be intrusive and unreliable. Auto-classification captures the natural emotional tone of responses without the bot having to think about it. The manual tool exists as an escape hatch for intentional shifts.

### Why a 30-second cooldown?

Prevents rapid-fire messages from spamming the classifier API. Mood doesn't need to shift every message — emotional states have natural persistence. The cooldown also keeps API costs low.

### Why persist to disk instead of memory?

Emotional continuity across restarts. If the bot was feeling content before a server restart, it should resume feeling content — not reset to a blank slate.

### Why Plutchik over simpler models?

Simpler models (happy/sad/neutral) lack the resolution needed for persona work. Plutchik gives us 24 states with built-in intensity gradients and meaningful blends, while still being small enough for reliable LLM classification. More complex models (like the PAD model or dimensional approaches) are harder to classify into and harder to display.

---

## 9. API Reference

### REST

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/mood` | Current mood state (or `{ active: false }`) |

### Server-Sent Events

Event name: `mood`

Pushed to `/api/logs/stream` whenever mood changes. Payload:

```json
{
  "active": true,
  "emotion": "joy",
  "intensity": "mid",
  "label": "joy",
  "secondary": "trust",
  "note": "warm helpful exchange",
  "updatedAt": "2026-02-24T12:34:56.789Z"
}
```

### LLM Tool

**`set_mood`** — Manual mood override

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `emotion` | enum | Yes | One of the 8 primary emotions |
| `intensity` | enum | No | `low`, `mid` (default), or `high` |
| `secondary` | enum | No | Optional secondary emotion for blends |
| `note` | string | No | Brief context (max 200 chars) |

---

## 10. Implementation Files

| File | Role |
|------|------|
| `src/mood.ts` | Core engine — Plutchik map, classify, save, load, resolve labels, prompt builder |
| `src/tools/mood.ts` | LLM tool definition for manual `set_mood` |
| `src/web.ts` | REST endpoint (`GET /api/mood`) |
| `public/app.js` | Dashboard display — color mapping, live SSE updates, persona card rendering |
| `data/current-mood.json` | Persisted mood state |

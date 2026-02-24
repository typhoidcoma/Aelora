# Luminora — Google Workspace Integration v1
_Gmail, Google Calendar & Google Docs for AI Personas_

---

## 0. Purpose

Give Aelora bots access to a Google Workspace account so they can:

- Search, read, send, reply to, and forward emails
- View, create, update, and delete Google Calendar events
- Search, read, create, and edit Google Docs

All three tools share a single set of OAuth2 credentials and a cached access token. The bot makes direct REST API calls to Google — no SDK dependencies.

---

## 1. Architecture Overview

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Discord /   │     │     Aelora       │     │   Google APIs    │
│  Web Chat    │────▶│  LLM Tool Call   │────▶│  gmail/calendar/ │
│  (user msg)  │     │  gmail.ts etc.   │     │  docs/drive      │
└──────────────┘     └──────┬───────────┘     └──────────────────┘
                            │
                     ┌──────▼───────────┐
                     │  _google-auth.ts │
                     │  OAuth2 Token    │
                     │  Cache & Refresh │
                     └──────────────────┘
```

The user talks to the bot via Discord or the web dashboard. The LLM decides to call a Google tool. The tool uses `_google-auth.ts` to get a Bearer token, then makes HTTPS requests to Google's REST APIs. Results are formatted as human-readable text and returned to the LLM, which incorporates them into its response.

---

## 2. OAuth2 Setup

### Prerequisites

1. A Google Cloud project with billing enabled
2. OAuth consent screen configured (internal or external)
3. A **Web application** OAuth 2.0 Client ID (not Desktop)
4. APIs enabled in the project:
   - Gmail API
   - Google Calendar API
   - Google Docs API
   - Google Drive API (for Docs search)

### Obtaining Credentials

**Client ID & Secret:**
1. Go to [Google Cloud Console — Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **+ CREATE CREDENTIALS** → **OAuth client ID**
3. Application type: **Web application**
4. Add authorized redirect URI: `https://developers.google.com/oauthplayground`
5. Copy the **Client ID** and **Client Secret**

**Refresh Token:**
1. Go to [Google OAuth Playground](https://developers.google.com/oauthplayground)
2. Click the **gear icon** (top right)
3. Check **"Use your own OAuth credentials"**
4. Paste your Client ID and Client Secret
5. In Step 1, type these scopes in the **"Input your own scopes"** box (don't use the checkboxes — they add restrictive sub-scopes):
   - `https://mail.google.com/`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/drive.readonly`
6. Click **Authorize APIs** → sign in with the target Google account → grant access
7. In Step 2, click **Exchange authorization code for tokens**
8. Copy the **Refresh token**

### Common Pitfalls

| Problem | Cause | Fix |
|---------|-------|-----|
| `unauthorized_client` | Refresh token not bound to your client ID | Redo OAuth Playground with gear settings filled in **before** authorizing |
| `redirect_uri_mismatch` | Playground URI not in authorized redirect URIs | Add `https://developers.google.com/oauthplayground` to your OAuth client |
| `Metadata scope does not support 'q' parameter` | Individual Gmail sub-scopes were selected instead of `mail.google.com` | Use the "Input your own scopes" box, type `https://mail.google.com/` directly |
| `Gmail API has not been used in project` | API not enabled in Google Cloud Console | Enable it at `console.developers.google.com/apis/api/gmail.googleapis.com` |
| 403 after enabling API | Propagation delay | Wait 2-5 minutes and retry |

---

## 3. Configuration

In `settings.yaml`:

```yaml
tools:
  google:
    clientId: "your-client-id.apps.googleusercontent.com"
    clientSecret: "your-client-secret"
    refreshToken: "1//your-refresh-token"
```

All three tools (`gmail`, `google_calendar`, `google_docs`) share this single config block. The refresh token is long-lived and doesn't expire unless revoked.

---

## 4. Shared Auth Module — `_google-auth.ts`

Underscore prefix means the tool registry skips it — it's a helper, not a tool.

### Token Lifecycle

1. First Google API call triggers `getGoogleAccessToken()`
2. Exchanges refresh token for access token via `https://oauth2.googleapis.com/token`
3. Access token cached module-level with 60-second pre-expiry buffer
4. Subsequent calls reuse cached token until it expires (~1 hour)
5. On auth errors, `resetGoogleToken()` clears cache to force re-auth

### Exports

| Function | Purpose |
|----------|---------|
| `getGoogleAccessToken(config)` | Get/refresh the access token |
| `googleFetch(url, config, init?)` | Fetch wrapper with auto-attached Bearer header |
| `resetGoogleToken()` | Clear cached token (called on errors) |
| `extractGoogleConfig(toolConfig)` | Extract typed config from tool's `toolConfig` |

---

## 5. Gmail Tool — `gmail`

**File:** `src/tools/gmail.ts`

### Actions

| Action | Required Params | Description |
|--------|----------------|-------------|
| `search` | `query` | Search emails using Gmail query syntax (`from:boss`, `is:unread`, `newer_than:7d`) |
| `read` | `messageId` | Read full email — headers, labels, decoded body text |
| `send` | `to`, `subject`, `body` | Send a new email |
| `reply` | `messageId`, `body` | Reply to an email (preserves thread via `In-Reply-To` header) |
| `forward` | `messageId`, `to` | Forward an email with original content and attribution |
| `labels` | — | List all Gmail labels with message counts |
| `draft` | `to`, `subject`, `body` | Create a draft without sending |

### Optional Params

- `cc` — CC recipients (comma-separated)
- `maxResults` — Max search results (1-20, default 5)

### Gmail Query Syntax Examples

```
from:boss subject:meeting          # From boss about meetings
is:unread newer_than:7d            # Unread in last 7 days
has:attachment filename:pdf         # Has PDF attachments
after:2026/02/01 before:2026/03/01 # Date range
label:important                     # Labeled important
```

### Technical Details

- Emails are built as RFC 2822 messages, base64url-encoded
- Body extraction handles multipart messages: prefers `text/plain`, falls back to HTML (stripped of tags)
- Reply preserves threading via `threadId`, `In-Reply-To`, and `References` headers
- Forward includes attribution block (`---------- Forwarded message ----------`)
- Body truncated at 4000 chars for very long emails

---

## 6. Google Calendar Tool — `google_calendar`

**File:** `src/tools/google-calendar.ts`

This is **separate from the CalDAV calendar** (Radicale). It operates on Google Calendar via the REST API.

### Actions

| Action | Required Params | Description |
|--------|----------------|-------------|
| `list` | — | List upcoming events (default: next 14 days, up to 10) |
| `create` | `summary`, `startDateTime`, `endDateTime` | Create a new event |
| `update` | `eventId` | Update event fields (PATCH — only changed fields sent) |
| `delete` | `eventId` | Delete an event |
| `calendars` | — | List all accessible calendars with IDs |

### Optional Params

- `description` — Event description
- `location` — Event location
- `calendarId` — Which calendar (default: `primary`)
- `maxResults` — Max events for list (1-50, default 10)
- `daysAhead` — Days ahead for list (1-365, default 14)

### Timezone Handling

Uses the system timezone (`process.env.TZ` from `settings.yaml`). Event start/end times are sent with the configured timezone so Google stores them correctly. Display formatting uses the same timezone.

---

## 7. Google Docs Tool — `google_docs`

**File:** `src/tools/google-docs.ts`

Requires `documents` and `drive.readonly` scopes (Drive is used for searching docs by name).

### Actions

| Action | Required Params | Description |
|--------|----------------|-------------|
| `search` | `query` | Find docs by name via Google Drive API |
| `read` | `documentId` | Read document content as plain text |
| `create` | `title` | Create a new blank doc (optionally with initial `text`) |
| `edit` | `documentId`, `text` | Insert text at `beginning` or `end` of document |

### Optional Params

- `text` — Initial content for create, or text to insert for edit
- `insertAt` — `"end"` (default) or `"beginning"`
- `maxResults` — Max docs for search (1-20, default 5)

### Technical Details

- Search uses Google Drive API filtered to `mimeType='application/vnd.google-apps.document'`
- Read extracts text by walking Docs API structural elements (paragraphs → text runs)
- Content truncated at 6000 chars for very long docs
- Edit uses `batchUpdate` with `InsertTextRequest`
- For end insertion: fetches doc to determine `endIndex`, inserts at `endIndex - 1`

---

## 8. Required OAuth Scopes

| Scope | Used By | Access Level |
|-------|---------|--------------|
| `https://mail.google.com/` | Gmail | Full Gmail access (read, send, search, labels) |
| `https://www.googleapis.com/auth/calendar` | Google Calendar | Full calendar access (read, write, delete) |
| `https://www.googleapis.com/auth/documents` | Google Docs | Full document access (read, create, edit) |
| `https://www.googleapis.com/auth/drive.readonly` | Google Docs (search) | Read-only Drive access (find docs by name) |

**Important:** Use `https://mail.google.com/` for Gmail — NOT the individual sub-scopes (`gmail.readonly`, `gmail.metadata`, etc.). The sub-scopes restrict search functionality.

---

## 9. Error Handling

All three tools follow the same error pattern:

1. **Config missing** — `defineTool()` auto-checks required config keys and returns helpful error
2. **Auth failure** — `resetGoogleToken()` clears cached token, next call re-authenticates
3. **API error** — HTTP status + Google error message returned to LLM
4. **Network failure** — Caught by try/catch, token cache cleared, error message returned

The LLM receives error messages as tool results and can explain them to the user or suggest fixes.

---

## 10. File Map

| File | Role |
|------|------|
| `src/tools/_google-auth.ts` | Shared OAuth2 token management (not a tool) |
| `src/tools/gmail.ts` | Gmail tool (7 actions) |
| `src/tools/google-calendar.ts` | Google Calendar tool (5 actions) |
| `src/tools/google-docs.ts` | Google Docs tool (4 actions) |
| `settings.yaml` | `tools.google` config block |

---

## 11. Verification Checklist

- [ ] OAuth client type is **Web application** (not Desktop)
- [ ] Redirect URI `https://developers.google.com/oauthplayground` added
- [ ] Gmail API enabled in Google Cloud Console
- [ ] Google Calendar API enabled
- [ ] Google Docs API enabled
- [ ] Google Drive API enabled
- [ ] Refresh token generated with **own credentials** checked in playground
- [ ] Scopes typed manually (not selected from checkboxes)
- [ ] `settings.yaml` has `tools.google.clientId`, `clientSecret`, `refreshToken`
- [ ] Aelora restarted after config changes
- [ ] Console shows `Tools: loaded "gmail"`, `"google_calendar"`, `"google_docs"` (enabled)

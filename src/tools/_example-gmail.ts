/**
 * _example-gmail.ts — Example tool template
 *
 * Shows how to build an API-integrated tool using defineTool().
 * This file is SKIPPED by the tool registry (underscore prefix).
 *
 * To use as a real tool:
 * 1. Copy to gmail.ts (remove the underscore)
 * 2. Add credentials to settings.yaml:
 *
 *    tools:
 *      gmail:
 *        clientId: "your-client-id"
 *        clientSecret: "your-client-secret"
 *        refreshToken: "your-refresh-token"
 *
 * 3. Restart the bot
 */

import { defineTool, param } from "./types.js";

// Module-level state: cached access token (survives between calls, not restarts)
let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Gmail OAuth error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000;
  return cachedAccessToken;
}

export default defineTool({
  name: "gmail_search",
  description:
    "Search Gmail inbox for emails matching a query. Returns subject, sender, date, and snippet for each result.",

  params: {
    query: param.string("Gmail search query (e.g., 'from:boss subject:meeting', 'is:unread')", {
      required: true,
    }),
    maxResults: param.number("Maximum emails to return (1-20). Default: 5.", {
      minimum: 1,
      maximum: 20,
    }),
  },

  config: ["gmail.clientId", "gmail.clientSecret", "gmail.refreshToken"],

  handler: async ({ query, maxResults }, { toolConfig }) => {
    const max = maxResults ?? 5;
    const { clientId, clientSecret, refreshToken } = toolConfig as {
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    };

    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);

    // Search for message IDs
    const searchUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query!)}&maxResults=${max}`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!searchRes.ok) {
      throw new Error(`Gmail API error: ${searchRes.status}`);
    }

    const searchData = (await searchRes.json()) as {
      messages?: { id: string }[];
      resultSizeEstimate: number;
    };

    if (!searchData.messages || searchData.messages.length === 0) {
      return `No emails found matching: "${query}"`;
    }

    // Fetch details for each message
    const emails = await Promise.all(
      searchData.messages.map(async (msg) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        const msgData = (await msgRes.json()) as {
          snippet: string;
          payload: { headers: { name: string; value: string }[] };
        };

        const headers = msgData.payload.headers;
        return {
          subject: headers.find((h) => h.name === "Subject")?.value ?? "(no subject)",
          from: headers.find((h) => h.name === "From")?.value ?? "(unknown)",
          date: headers.find((h) => h.name === "Date")?.value ?? "",
          snippet: msgData.snippet,
        };
      }),
    );

    return JSON.stringify(emails, null, 2);
  },
});

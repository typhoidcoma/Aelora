/**
 * _google-auth.ts — Shared Google OAuth2 token management
 *
 * Underscore prefix = skipped by tool registry (helper module, not a tool).
 * Used by gmail.ts, google-calendar.ts, and google-docs.ts.
 */

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

// Module-level token cache (shared across all Google tools)
let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Exchange a refresh token for an access token (cached with expiry).
 * Throws on failure — callers should catch and return tool error strings.
 */
export async function getGoogleAccessToken(config: GoogleConfig): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    cachedAccessToken = null;
    throw new Error(`Google OAuth error (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000; // 60s buffer
  return cachedAccessToken;
}

/**
 * Authenticated fetch wrapper for Google APIs.
 * Auto-attaches Bearer token. Callers check res.ok themselves.
 */
export async function googleFetch(
  url: string,
  config: GoogleConfig,
  init?: RequestInit,
): Promise<Response> {
  const token = await getGoogleAccessToken(config);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

/** Reset cached token (call on auth errors to force re-auth). */
export function resetGoogleToken(): void {
  cachedAccessToken = null;
  tokenExpiresAt = 0;
}

/** Extract GoogleConfig from toolConfig resolved by defineTool(). */
export function extractGoogleConfig(toolConfig: Record<string, unknown>): GoogleConfig {
  return {
    clientId: toolConfig.clientId as string,
    clientSecret: toolConfig.clientSecret as string,
    refreshToken: toolConfig.refreshToken as string,
  };
}

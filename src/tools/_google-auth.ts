/**
 * _google-auth.ts  -  Shared Google OAuth2 token management
 *
 * Underscore prefix = skipped by tool registry (helper module, not a tool).
 * Used by gmail.ts, google-calendar.ts, and google-docs.ts.
 */

import { log } from "../logger.js";
import { record } from "../api-health.js";

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

// Module-level token cache (shared across all Google tools)
let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;
// Dedup in-flight refresh requests to prevent thundering herd
let _refreshPromise: Promise<string> | null = null;

/**
 * Exchange a refresh token for an access token (cached with expiry).
 * Throws on failure  -  callers should catch and return tool error strings.
 * Uses promise dedup to prevent multiple concurrent refresh requests.
 */
export async function getGoogleAccessToken(config: GoogleConfig): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }

  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = _doTokenRefresh(config).finally(() => {
    _refreshPromise = null;
  });

  return _refreshPromise;
}

async function _doTokenRefresh(config: GoogleConfig): Promise<string> {
  const start = Date.now();
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
  const duration = Date.now() - start;

  if (!res.ok) {
    const body = await res.text();
    cachedAccessToken = null;
    log.external("google-oauth", "token refresh", { duration, status: res.status, error: body.slice(0, 200) });
    record("google-oauth", false, duration, `${res.status}`);
    throw new Error(`Google OAuth error (${res.status}): ${body.slice(0, 200)}`);
  }

  log.external("google-oauth", "token refresh", { duration, status: 200 });
  record("google-oauth", true, duration);

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000; // 60s buffer
  return cachedAccessToken;
}

/**
 * Authenticated fetch wrapper for Google APIs.
 * Auto-attaches Bearer token, logs timing + errors, records health stats.
 */
export async function googleFetch(
  url: string,
  config: GoogleConfig,
  init?: RequestInit,
): Promise<Response> {
  const token = await getGoogleAccessToken(config);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);

  const start = Date.now();
  const res = await fetch(url, { ...init, headers });
  const duration = Date.now() - start;

  // Derive service name from URL
  const service = url.includes("gmail") ? "gmail"
    : url.includes("calendar") ? "calendar"
    : url.includes("tasks") ? "tasks"
    : url.includes("docs.google") ? "docs"
    : url.includes("drive") ? "drive"
    : "google";

  const method = init?.method ?? "GET";

  if (!res.ok) {
    log.external(service, `${method} ${res.status}`, { duration, status: res.status, error: url.split("?")[0] });
    record(service, false, duration, `${method} ${res.status}`);
  } else {
    record(service, true, duration);
  }

  return res;
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

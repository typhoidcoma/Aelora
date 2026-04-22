/**
 * Long-lived undici Agent for LLM calls. HTTP/2 when the endpoint supports it,
 * HTTP/1.1 keepalive otherwise. Exposes connection counters via diagnostics_channel
 * so we can confirm connection reuse in production.
 */

import diagnostics_channel from "node:diagnostics_channel";
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import type { Config } from "../config.js";

let agent: Agent | null = null;
let connected = 0;
let disconnected = 0;
let requestCount = 0;
let diagnosticsWired = false;

function wireDiagnostics(): void {
  if (diagnosticsWired) return;
  diagnosticsWired = true;
  try {
    diagnostics_channel.channel("undici:client:connected").subscribe(() => { connected++; });
    diagnostics_channel.channel("undici:client:disconnected").subscribe(() => { disconnected++; });
  } catch {
    // diagnostics channels unavailable — counters stay at 0
  }
}

export type LLMFetch = typeof globalThis.fetch;

export type LLMTransportBundle = {
  fetch: LLMFetch | undefined;
  agent: Agent | null;
  enabled: boolean;
};

/**
 * Build an undici-backed fetch if http2Enabled in config. Returns undefined fetch
 * when disabled so the OpenAI SDK falls back to its default.
 */
export function createLLMTransport(cfg: Config): LLMTransportBundle {
  if (!cfg.llm.http2Enabled) {
    return { fetch: undefined, agent: null, enabled: false };
  }

  wireDiagnostics();

  if (!agent) {
    agent = new Agent({
      allowH2: true,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
      pipelining: 1,
      connect: { keepAlive: true },
    });
    try { setGlobalDispatcher(agent); } catch { /* non-fatal */ }
    console.log("LLM: HTTP/2 keepalive enabled (undici agent)");
  }

  const boundAgent = agent;
  const bound = (async (input: unknown, init?: unknown): Promise<unknown> => {
    requestCount++;
    if (requestCount % 25 === 0) {
      console.log(`LLM: connection stats — opened=${connected} closed=${disconnected} requests=${requestCount}`);
    }
    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...((init ?? {}) as object), dispatcher: boundAgent } as Parameters<typeof undiciFetch>[1],
    );
  }) as unknown as LLMFetch;

  return { fetch: bound, agent: boundAgent, enabled: true };
}

export function getLLMTransportStats(): {
  enabled: boolean;
  opened: number;
  closed: number;
  requests: number;
  inflight: number;
} {
  return {
    enabled: agent !== null,
    opened: connected,
    closed: disconnected,
    requests: requestCount,
    inflight: Math.max(0, connected - disconnected),
  };
}

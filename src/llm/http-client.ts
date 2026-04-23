/**
 * Long-lived undici Agent for LLM calls. HTTP/2 when the endpoint supports it,
 * HTTP/1.1 keepalive otherwise. Installed as the global dispatcher so the
 * OpenAI SDK's built-in fetch transparently picks up the pooled connection —
 * we do NOT swap the SDK's fetch, which avoids Response/ReadableStream shape
 * drift between undici and the SDK's internal expectations.
 */

import diagnostics_channel from "node:diagnostics_channel";
import { Agent, setGlobalDispatcher } from "undici";
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
    diagnostics_channel.channel("undici:request:create").subscribe(() => {
      requestCount++;
      if (requestCount % 25 === 0) {
        console.log(`LLM: connection stats — opened=${connected} closed=${disconnected} requests=${requestCount}`);
      }
    });
  } catch {
    // diagnostics channels unavailable — counters stay at 0
  }
}

export type LLMTransportBundle = {
  agent: Agent | null;
  enabled: boolean;
};

/**
 * Install the undici agent as global dispatcher. The OpenAI SDK uses global
 * fetch which undici routes through this dispatcher — we get pooling + H2
 * without substituting the fetch implementation.
 */
export function createLLMTransport(cfg: Config): LLMTransportBundle {
  if (!cfg.llm.http2Enabled) {
    return { agent: null, enabled: false };
  }

  if (!agent) {
    agent = new Agent({
      allowH2: true,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
      pipelining: 1,
      connect: { keepAlive: true },
    });
    try {
      setGlobalDispatcher(agent);
      wireDiagnostics();
      console.log("LLM: HTTP/2 keepalive enabled (undici global dispatcher)");
    } catch (err) {
      console.warn("LLM: failed to install undici dispatcher, falling back to default:", err instanceof Error ? err.message : err);
      agent = null;
      return { agent: null, enabled: false };
    }
  }

  return { agent, enabled: true };
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

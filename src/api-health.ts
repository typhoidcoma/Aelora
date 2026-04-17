/**
 * api-health.ts  -  Simple in-memory API health counters per external service.
 *
 * Rolling 1-hour window. Call `record()` from instrumented fetch/query wrappers;
 * read via `getHealthReport()` (exposed at GET /api/health).
 */

type ServiceStats = {
  success: number;
  error: number;
  totalDurationMs: number;
  lastError?: { message: string; at: string };
  lastSuccess?: string;
};

let currentHour = "";
const stats = new Map<string, ServiceStats>();

/** Record a single external API call outcome. */
export function record(
  service: string,
  success: boolean,
  durationMs: number,
  errorMsg?: string,
): void {
  // Roll over on hour boundary
  const hour = new Date().toISOString().slice(0, 13);
  if (hour !== currentHour) {
    stats.clear();
    currentHour = hour;
  }

  let s = stats.get(service);
  if (!s) {
    s = { success: 0, error: 0, totalDurationMs: 0 };
    stats.set(service, s);
  }

  if (success) {
    s.success++;
    s.lastSuccess = new Date().toISOString();
  } else {
    s.error++;
    s.lastError = { message: errorMsg ?? "unknown", at: new Date().toISOString() };
  }
  s.totalDurationMs += durationMs;
}

export type HealthReport = Record<string, ServiceStats & { avgDurationMs: number }>;

/** Get current-hour health stats for all tracked services. */
export function getHealthReport(): HealthReport {
  const result: HealthReport = {};
  for (const [service, s] of stats) {
    const total = s.success + s.error;
    result[service] = {
      ...s,
      avgDurationMs: total > 0 ? Math.round(s.totalDurationMs / total) : 0,
    };
  }
  return result;
}

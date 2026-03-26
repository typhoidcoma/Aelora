/**
 * Shared engagement tracker — single source of truth for
 * "the bot recently engaged this channel" across all response paths
 * (ambient engine, name-triggered replies, reply-check heartbeat).
 *
 * Prevents cascading loops by ensuring only one voluntary response
 * per channel within a cooldown window.
 */

const lastEngagement = new Map<string, { at: number; source: string }>();

/** Record that the bot just engaged a channel. */
export function recordEngagement(channelId: string, source: string): void {
  lastEngagement.set(channelId, { at: Date.now(), source });
}

/** Check if the bot can engage a channel (cooldown expired). */
export function canEngage(channelId: string, cooldownMs: number): boolean {
  const last = lastEngagement.get(channelId);
  if (!last) return true;
  return Date.now() - last.at >= cooldownMs;
}

/** Get last engagement info for a channel (for debugging/dashboard). */
export function getLastEngagement(channelId: string): { at: number; source: string } | undefined {
  return lastEngagement.get(channelId);
}

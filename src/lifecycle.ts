/**
 * Process lifecycle helpers.
 * Kept in a tiny module so web.ts and discord commands can import
 * without pulling in all of index.ts.
 */

import { stopHeartbeat } from "./heartbeat.js";
import { stopCron } from "./cron.js";

const REBOOT_CODE = 100;

/** Gracefully shut down all subsystems and exit with the reboot code. */
export function reboot(): void {
  console.log("Reboot requested — shutting down...");
  stopHeartbeat();
  stopCron();
  // The boot wrapper sees exit code 100 and restarts the process
  process.exit(REBOOT_CODE);
}

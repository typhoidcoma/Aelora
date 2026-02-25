/**
 * Boot wrapper — spawns the main process and handles restarts.
 *
 * Exit code 100 = reboot (immediate restart)
 * Exit code 1+  = crash  (restart after 3s delay, with loop protection)
 * Exit code 0   = clean shutdown (propagate to parent)
 *
 * Usage:
 *   tsx src/boot.ts       (dev)
 *   node dist/boot.js     (prod)
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REBOOT_CODE = 100;
const MAX_RAPID_CRASHES = 3;
const CRASH_WINDOW_MS = 60_000; // 1 minute

const crashTimestamps: number[] = [];

function start(): void {
  const bootPath = fileURLToPath(import.meta.url);
  const indexPath = bootPath.replace(/boot\.(ts|js)$/, "index.$1");

  // Re-run with the same runtime flags (preserves tsx loader in dev)
  const child = spawn(process.execPath, [...process.execArgv, indexPath], {
    stdio: "inherit",
  });

  // Forward signals to child for clean shutdown (systemd sends SIGTERM to stop)
  const onSIGTERM = () => child.kill("SIGTERM");
  process.on("SIGTERM", onSIGTERM);

  // On Windows, SIGINT (Ctrl+C) is delivered directly to all processes in the
  // console group via CTRL_C_EVENT. Calling child.kill("SIGINT") on Windows
  // invokes TerminateProcess(), which force-kills the child before its SIGINT
  // handler can run saveState(). Register a no-op handler to keep boot.ts alive
  // while the child shuts down on its own.
  const onSIGINT = process.platform === "win32"
    ? () => {}
    : () => child.kill("SIGINT");
  process.on("SIGINT", onSIGINT);

  child.on("exit", (code) => {
    process.removeListener("SIGTERM", onSIGTERM);
    process.removeListener("SIGINT", onSIGINT);
    if (code === REBOOT_CODE) {
      console.log("\n--- Rebooting ---\n");
      start();
      return;
    }

    if (code !== 0 && code !== null) {
      // Crash — check for rapid crash loop
      const now = Date.now();
      crashTimestamps.push(now);

      // Only keep crashes within the window
      while (crashTimestamps.length > 0 && crashTimestamps[0] < now - CRASH_WINDOW_MS) {
        crashTimestamps.shift();
      }

      if (crashTimestamps.length >= MAX_RAPID_CRASHES) {
        console.error(
          `\n--- ${MAX_RAPID_CRASHES} crashes in ${CRASH_WINDOW_MS / 1000}s, giving up ---\n`,
        );
        process.exit(code);
      }

      console.log(`\n--- Process crashed (code ${code}), restarting in 3s ---\n`);
      setTimeout(start, 3_000);
      return;
    }

    // Clean exit — propagate
    process.exit(code ?? 0);
  });
}

start();

/**
 * Boot wrapper — spawns the main process and restarts it when
 * it exits with code 100 (reboot signal).
 *
 * Usage:
 *   tsx src/boot.ts       (dev)
 *   node dist/boot.js     (prod)
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REBOOT_CODE = 100;

function start(): void {
  const bootPath = fileURLToPath(import.meta.url);
  const indexPath = bootPath.replace(/boot\.(ts|js)$/, "index.$1");

  // Re-run with the same runtime flags (preserves tsx loader in dev)
  const child = spawn(process.execPath, [...process.execArgv, indexPath], {
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    if (code === REBOOT_CODE) {
      console.log("\n--- Rebooting ---\n");
      start();
    } else {
      process.exit(code ?? 0);
    }
  });
}

start();

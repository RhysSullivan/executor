/**
 * Kills all processes started by `bun dev`.
 *
 * 1. Reads PIDs from .dev.pids and kills process trees
 * 2. Falls back to killing anything on known dev ports (3000, 3002)
 *
 * Usage: bun run kill:all
 */

import { join } from "node:path";
import { unlinkSync } from "node:fs";

const PID_FILE = join(import.meta.dir, ".dev.pids");
const DEV_PORTS = [3000, 3002];

let killed = 0;
let skipped = 0;

function killPid(pid: number) {
  // Kill children first
  try {
    Bun.spawnSync(["pkill", "-TERM", "--parent", String(pid)]);
  } catch {}

  try {
    process.kill(pid, "SIGTERM");
    console.log(`  Killed PID ${pid}`);
    killed++;
  } catch (err: any) {
    if (err.code === "ESRCH") {
      skipped++;
    } else {
      console.error(`  Failed to kill PID ${pid}: ${err.message}`);
    }
  }
}

// ── Phase 1: Kill PIDs from the PID file ──

const file = Bun.file(PID_FILE);
if (await file.exists()) {
  const pids = (await file.text())
    .split("\n").map((l) => l.trim()).filter(Boolean).map(Number).filter((n) => !isNaN(n));

  if (pids.length > 0) {
    console.log("Killing tracked processes...");
    for (const pid of pids) killPid(pid);
  }

  try { unlinkSync(PID_FILE); } catch {}
}

// ── Phase 2: Kill anything still on dev ports ──

for (const port of DEV_PORTS) {
  const result = Bun.spawnSync(["fuser", "-k", `${port}/tcp`], { stderr: "pipe" });
  const stderr = result.stderr.toString().trim();
  if (stderr && stderr.includes(String(port))) {
    console.log(`Killed processes on port ${port}`);
    killed++;
  }
}

if (killed === 0 && skipped === 0) {
  console.log("Nothing to kill.");
} else {
  console.log(
    `\nDone. Killed ${killed} process${killed !== 1 ? "es" : ""}${
      skipped > 0 ? `, ${skipped} already stopped` : ""
    }.`,
  );
}

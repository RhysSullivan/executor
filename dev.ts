/**
 * Dev runner — starts all services concurrently with colored output.
 *
 * Usage: bun dev
 *
 * Reads all configuration from the root .env file (auto-loaded by Bun).
 *
 * Starts:
 *   1. Sources catalog API (port 4343)    ─┐
 *   2. Convex cloud dev function watcher   │
 *   3. CF sandbox host worker (port 8787) ├─ all started concurrently
 *   4. Executor web UI (port 4312)        │
 *   5. Assistant server (port 3002)       │
 *   6. Discord bot                        ─┘
 *
 * All processes are killed when this script exits (Ctrl+C).
 * PIDs are written to .dev.pids for use with `bun run kill:all`.
 */

import { join } from "node:path";
import { unlinkSync } from "node:fs";

const PID_FILE = join(import.meta.dir, ".dev.pids");

const colors = {
  sources: "\x1b[33m",  // yellow
  convex: "\x1b[36m",   // cyan
  web: "\x1b[34m",      // blue
  sandbox: "\x1b[91m",  // bright red
  assistant: "\x1b[32m", // green
  bot: "\x1b[35m",      // magenta
  reset: "\x1b[0m",
};

type ServiceName = keyof typeof colors;

function prefix(name: ServiceName, line: string): string {
  return `${colors[name]}[${name}]${colors.reset} ${line}`;
}

const procs: Bun.Subprocess[] = [];

function writePidFile() {
  const pids = [process.pid, ...procs.map((p) => p.pid)].join("\n");
  Bun.write(PID_FILE, pids);
}

function removePidFile() {
  try { unlinkSync(PID_FILE); } catch {}
}

function toSiteUrl(convexUrl: string): string {
  if (convexUrl.includes(".convex.cloud")) {
    return convexUrl.replace(".convex.cloud", ".convex.site");
  }
  return convexUrl;
}

function resolveExecutorUrls(): { convexUrl: string; executorUrl: string } {
  const convexUrl = Bun.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is not set. Add it to the root .env file.");
  }
  const executorUrl = Bun.env.CONVEX_SITE_URL ?? toSiteUrl(convexUrl);
  return { convexUrl, executorUrl };
}

function spawnService(name: ServiceName, cmd: string[], opts: {
  cwd?: string;
  env?: Record<string, string>;
} = {}): Bun.Subprocess {
  console.log(prefix(name, `Starting: ${cmd.join(" ")}`));
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? ".",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, FORCE_COLOR: "1", ...opts.env },
  });
  procs.push(proc);
  writePidFile();

  const stream = async (s: ReadableStream<Uint8Array>, isErr: boolean) => {
    const reader = s.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          (isErr ? process.stderr : process.stdout).write(prefix(name, line) + "\n");
        }
      }
    }
    if (buf.trim()) {
      (isErr ? process.stderr : process.stdout).write(prefix(name, buf) + "\n");
    }
  };

  stream(proc.stdout, false);
  stream(proc.stderr, true);
  proc.exited.then((code) => console.log(prefix(name, `Exited with code ${code}`)));
  return proc;
}

// ── Cleanup ──

function shutdown() {
  console.log("\nShutting down all services...");
  for (const proc of procs) proc.kill();
  removePidFile();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Kill stale processes from a previous run ──

const EXECUTOR_WEB_PORT = Number(Bun.env.EXECUTOR_WEB_PORT ?? 4312);
const SANDBOX_PORT = Number(Bun.env.SANDBOX_PORT ?? 8787);
const ASSISTANT_PORT = Number(Bun.env.ASSISTANT_PORT ?? 3002);
const DEV_PORTS = [ASSISTANT_PORT, EXECUTOR_WEB_PORT, SANDBOX_PORT];

async function killStaleProcesses() {
  let killed = 0;

  // Kill tracked PIDs
  const file = Bun.file(PID_FILE);
  if (await file.exists()) {
    const pids = (await file.text())
      .split("\n").map((l) => l.trim()).filter(Boolean).map(Number).filter((n) => !isNaN(n));

    for (const pid of pids) {
      try { Bun.spawnSync(["pkill", "-TERM", "--parent", String(pid)]); } catch {}
      try { process.kill(pid, "SIGTERM"); killed++; } catch {}
    }
    removePidFile();
  }

  // Kill anything still on dev ports
  for (const port of DEV_PORTS) {
    const result = Bun.spawnSync(["fuser", "-k", `${port}/tcp`], { stderr: "pipe" });
    const stderr = result.stderr.toString().trim();
    if (stderr && stderr.includes(String(port))) killed++;
  }

  if (killed > 0) {
    console.log(`Killed ${killed} stale process(es) from previous run.\n`);
    await Bun.sleep(500);
  }
}

// ── Start everything ──

await killStaleProcesses();

// Write PID file immediately so kill:all works even before services spawn
writePidFile();

console.log("Starting all services...\n");
if (!Bun.env.DISCORD_BOT_TOKEN) {
  console.log(`${colors.bot}[bot]${colors.reset} Skipped — no DISCORD_BOT_TOKEN set\n`);
}

const urls = resolveExecutorUrls();
console.log(prefix("convex", `Using Convex URL: ${urls.convexUrl}`));
console.log(prefix("convex", `Using executor HTTP URL: ${urls.executorUrl}`));

// 1. Sources catalog API
spawnService("sources", ["bun", "--hot", "server.ts"], {
  cwd: "./sources",
});

// 2. Start Convex file watcher (non-blocking — repushes on changes)
spawnService("convex", [
  "bunx", "convex", "dev",
  "--typecheck", "disable",
  "--env-file", "../.env",
], {
  cwd: "./executor",
});

// 3. CF sandbox host worker (local wrangler dev for iterating on the worker)
spawnService("sandbox", [
  "bunx", "wrangler", "dev",
  "--port", String(SANDBOX_PORT),
], {
  cwd: "./executor/packages/runner-sandbox-host",
});

// 4. Everything else in parallel
spawnService("web", ["bun", "run", "dev"], {
  cwd: "./executor/apps/web",
});

spawnService("assistant", ["bun", "run", "dev"], {
  cwd: "./assistant/packages/server",
  env: {
    ASSISTANT_PORT: String(ASSISTANT_PORT),
    EXECUTOR_URL: urls.executorUrl,
    CONVEX_URL: urls.convexUrl,
    EXECUTOR_ANON_SESSION_ID: Bun.env.EXECUTOR_ANON_SESSION_ID ?? "assistant-discord-dev",
    EXECUTOR_CLIENT_ID: Bun.env.EXECUTOR_CLIENT_ID ?? "bot",
  },
});

if (Bun.env.DISCORD_BOT_TOKEN) {
  spawnService("bot", ["bun", "run", "dev"], {
    cwd: "./assistant/packages/bot",
    env: {
      ASSISTANT_SERVER_URL: Bun.env.ASSISTANT_SERVER_URL ?? `http://localhost:${ASSISTANT_PORT}`,
      CONVEX_URL: urls.convexUrl,
    },
  });
}

// Keep alive
await new Promise(() => {});

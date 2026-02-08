/**
 * Dev runner — starts all services concurrently with colored output.
 *
 * Usage: bun dev
 *
 * Starts:
 *   1. Convex local backend (port 3210)
 *   2. Convex function push (once)
 *   3. Executor server (port 4001)
 *   4. Executor web UI (port 3002)
 *   5. Assistant server (port 3000)
 *   6. Discord bot
 *   7. Convex function watcher (watches for schema/function changes)
 *
 * All processes are killed when this script exits (Ctrl+C).
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const colors = {
  convex: "\x1b[36m",   // cyan
  executor: "\x1b[33m", // yellow
  web: "\x1b[34m",      // blue
  assistant: "\x1b[32m", // green
  bot: "\x1b[35m",      // magenta
  reset: "\x1b[0m",
};

type ServiceName = keyof typeof colors;

function prefix(name: ServiceName, line: string): string {
  return `${colors[name]}[${name}]${colors.reset} ${line}`;
}

const procs: Bun.Subprocess[] = [];

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

// ── Convex local backend ──

async function findBackendBinary(): Promise<string> {
  const binDir = join(homedir(), ".cache", "convex", "binaries");
  if (!existsSync(binDir)) {
    throw new Error(`No convex-local-backend found. Run: bun executor/apps/server/src/cli.ts start`);
  }
  const entries = await readdir(binDir);
  for (const entry of entries) {
    const path = join(binDir, entry, "convex-local-backend");
    if (existsSync(path)) return path;
  }
  throw new Error(`No convex-local-backend binary found in ${binDir}`);
}

async function waitForBackend(url: string, timeoutMs = 15_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${url}/instance_name`);
      if (resp.ok) return await resp.text();
    } catch { /* not ready */ }
    await Bun.sleep(200);
  }
  throw new Error(`Convex backend did not start within ${timeoutMs}ms`);
}

interface BackendConfig {
  adminKey: string;
  instanceSecret: string;
  ports: { cloud: number; site: number };
}

async function readBackendConfig(instanceName: string): Promise<BackendConfig> {
  for (const base of [
    join(homedir(), ".convex", "convex-backend-state"),
    join(homedir(), ".convex", "anonymous-convex-backend-state"),
  ]) {
    const configPath = join(base, instanceName, "config.json");
    if (existsSync(configPath)) {
      return await Bun.file(configPath).json();
    }
  }
  throw new Error(`No config found for instance: ${instanceName}`);
}

const CONVEX_INSTANCE = "local-rhys_sullivan-executor";

async function startConvexBackend(): Promise<{ url: string; adminKey: string }> {
  const CONVEX_PORT = 3210;
  const url = `http://127.0.0.1:${CONVEX_PORT}`;

  // Check if already running
  try {
    const instanceName = await waitForBackend(url, 1000);
    console.log(prefix("convex", `Backend already running: ${instanceName}`));
    const config = await readBackendConfig(instanceName);
    return { url, adminKey: config.adminKey };
  } catch { /* not running, start it */ }

  const binary = await findBackendBinary();
  const config = await readBackendConfig(CONVEX_INSTANCE);
  spawnService("convex", [
    binary,
    "--port", String(CONVEX_PORT),
    "--instance-name", CONVEX_INSTANCE,
    "--instance-secret", config.instanceSecret,
  ]);

  const instanceName = await waitForBackend(url);
  console.log(prefix("convex", `Backend ready: ${instanceName}`));
  return { url, adminKey: config.adminKey };
}

async function pushConvexFunctions(backendUrl: string, adminKey: string): Promise<void> {
  console.log(prefix("convex", "Pushing functions..."));

  const envFile = join(import.meta.dir, "executor", ".env.executor-push");
  await Bun.write(envFile, [
    `CONVEX_SELF_HOSTED_URL=${backendUrl}`,
    `CONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}`,
  ].join("\n"));

  const cleanEnv = { ...Bun.env };
  delete cleanEnv.CONVEX_DEPLOYMENT;

  const proc = Bun.spawn([
    "bunx", "convex", "dev", "--once",
    "--typecheck", "disable",
    "--env-file", envFile,
  ], {
    cwd: "./executor",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...cleanEnv, FORCE_COLOR: "1" },
  });

  const stdout = await Bun.readableStreamToText(proc.stdout);
  const stderr = await Bun.readableStreamToText(proc.stderr);
  const code = await proc.exited;

  if (stdout.trim()) console.log(prefix("convex", stdout.trim()));
  if (code !== 0) {
    console.error(prefix("convex", `Push failed (exit ${code}): ${stderr.trim()}`));
    throw new Error("Convex function push failed");
  }
  console.log(prefix("convex", "Functions ready!"));
}

// ── Cleanup ──

process.on("SIGINT", () => {
  console.log("\nShutting down all services...");
  for (const proc of procs) proc.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  for (const proc of procs) proc.kill();
  process.exit(0);
});

// ── Start everything ──

console.log("Starting all services...\n");
if (!Bun.env.DISCORD_BOT_TOKEN) {
  console.log(`${colors.bot}[bot]${colors.reset} Skipped — no DISCORD_BOT_TOKEN set\n`);
}

// 1. Convex backend (must be ready before anything else)
const convex = await startConvexBackend();

// 2. Push functions (must complete before executor starts)
await pushConvexFunctions(convex.url, convex.adminKey);

// 3. Start Convex file watcher (repushes on changes, no backend management)
spawnService("convex", [
  "bunx", "convex", "dev",
  "--typecheck", "disable",
  "--env-file", join(import.meta.dir, "executor", ".env.executor-push"),
], {
  cwd: "./executor",
  env: (() => { const e = { ...Bun.env }; delete e.CONVEX_DEPLOYMENT; return e; })(),
});

// 4. Everything else in parallel
spawnService("executor", ["bun", "--hot", "apps/server/src/index.ts"], {
  cwd: "./executor",
  env: { EXECUTOR_SERVER_AUTO_EXECUTE: "1" },
});

spawnService("web", ["bun", "run", "dev", "--", "-p", "3002"], {
  cwd: "./executor/apps/web",
});

// Small delay for executor to be ready
await Bun.sleep(2000);

spawnService("assistant", ["bun", "run", "--cwd", "packages/server", "dev"], {
  cwd: "./assistant",
});

if (Bun.env.DISCORD_BOT_TOKEN) {
  await Bun.sleep(1000);
  spawnService("bot", ["bun", "run", "--cwd", "packages/bot", "dev"], {
    cwd: "./assistant",
  });
}

// Keep alive
await new Promise(() => {});

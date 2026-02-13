#!/usr/bin/env bun

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { managedRuntimeDiagnostics, runManagedBackend, runManagedWeb } from "./packages/core/src/managed-runtime";

function printHelp(): void {
  console.log(`Executor CLI

Usage:
  executor doctor
  executor up [backend-args]
  executor backend <args>
  executor web [--port <number>]
  executor uninstall [--yes]

Commands:
  doctor        Bootstrap and verify managed Convex backend runtime
  up            Run managed backend and auto-bootstrap Convex functions
  backend       Pass through arguments to managed convex-local-backend binary
  web           Run packaged web UI (default port: 5312)
  uninstall     Remove local managed runtime install
`);
}

function parsePort(args: string[]): number | undefined {
  const flagIndex = args.findIndex((arg) => arg === "--port");
  if (flagIndex === -1) {
    return undefined;
  }

  const raw = args[flagIndex + 1];
  if (!raw) {
    throw new Error("Missing value for --port");
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }

  return port;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function checkHttp(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runUninstall(args: string[]): Promise<number> {
  let assumeYes = false;
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    if (arg === "-y" || arg === "--yes") {
      assumeYes = true;
      index += 1;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      console.log(`Usage:
  executor uninstall [--yes]

Options:
  -y, --yes     Skip confirmation prompt
  -h, --help    Show this help`);
      return 0;
    }

    console.log(`Unknown option: ${arg}`);
    return 1;
  }

  const installDir = Bun.env.EXECUTOR_INSTALL_DIR ?? path.join(os.homedir(), ".executor", "bin");
  const runtimeDir = Bun.env.EXECUTOR_RUNTIME_DIR ?? path.join(os.homedir(), ".executor", "runtime");
  const homeDir = Bun.env.EXECUTOR_HOME_DIR ?? path.join(os.homedir(), ".executor");

  if (!assumeYes) {
    console.log("This will remove:");
    console.log(`  - ${installDir}/executor`);
    console.log(`  - ${runtimeDir}`);
    const response = prompt("Continue? [y/N] ");
    if (response === null || response.toLowerCase() !== "y") {
      console.log("Cancelled.");
      return 0;
    }
  }

  await fs.rm(path.join(installDir, "executor"), { force: true });
  await fs.rm(runtimeDir, { recursive: true, force: true });

  if (await pathExists(installDir)) {
    try {
      await fs.rmdir(installDir);
    } catch {
      // keep if it is not empty
    }
  }

  if (await pathExists(homeDir)) {
    try {
      await fs.rmdir(homeDir);
    } catch {
      // keep if other files remain
    }
  }

  console.log("Executor uninstall complete.");
  console.log("");
  console.log("If you previously added PATH manually, remove this line from your shell rc:");
  console.log(`  export PATH=${installDir}:$PATH`);
  return 0;
}

async function run(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "doctor") {
    const info = await managedRuntimeDiagnostics();
    const webPort = Number(Bun.env.EXECUTOR_WEB_PORT ?? 5312);
    const webInstalled = await pathExists(info.webServerEntry);
    const nodeInstalled = await pathExists(info.nodeBin);
    const backendRunning = await checkHttp(`${info.convexUrl}/version`);
    const webRunning = await checkHttp(`http://127.0.0.1:${webPort}/`);

    console.log("Managed runtime ready");
    console.log(`  root: ${info.rootDir}`);
    console.log(`  backend: ${info.backendVersion} (${info.backendBinary})`);
    console.log(`  convex URL: ${info.convexUrl}`);
    console.log(`  convex site: ${info.convexSiteUrl}`);
    console.log(`  node runtime: ${nodeInstalled ? info.nodeBin : "not installed yet (installed by 'executor web')"}`);
    console.log(`  web bundle: ${webInstalled ? info.webServerEntry : "not installed yet (installed by 'executor web')"}`);
    console.log(`  web URL: http://127.0.0.1:${webPort}`);
    console.log(`  mcp URL: ${info.convexSiteUrl}/mcp`);
    console.log(`  running: backend=${backendRunning ? "yes" : "no"} web=${webRunning ? "yes" : "no"}`);
    console.log(`  config: ${info.configPath}`);
    return;
  }

  if (command === "up") {
    const exitCode = await runManagedBackend(rest);
    process.exit(exitCode);
  }

  if (command === "backend" || command === "convex") {
    if (rest.length === 0) {
      throw new Error("Missing backend arguments. Example: executor backend --help");
    }
    const exitCode = await runManagedBackend(rest);
    process.exit(exitCode);
  }

  if (command === "web") {
    const port = parsePort(rest);
    const exitCode = await runManagedWeb({ port });
    process.exit(exitCode);
  }

  if (command === "uninstall") {
    const exitCode = await runUninstall(rest);
    process.exit(exitCode);
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`executor: ${message}`);
  process.exit(1);
}

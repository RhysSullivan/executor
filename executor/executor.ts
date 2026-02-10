#!/usr/bin/env bun

import fs from "node:fs/promises";
import { startMcpGateway } from "./mcp-gateway";
import { managedRuntimeDiagnostics, runManagedBackend, runManagedWeb } from "./lib/managed_runtime";

function printHelp(): void {
  console.log(`Executor CLI

Usage:
  executor doctor
  executor up [backend-args]
  executor backend <args>
  executor web [--port <number>]
  executor gateway [--port <number>]

Commands:
  doctor        Bootstrap and verify managed Convex backend runtime
  up            Run managed backend and auto-bootstrap Convex functions
  backend       Pass through arguments to managed convex-local-backend binary
  web           Run packaged web UI (default port: 5312)
  gateway       Start Executor MCP gateway (default port: 5313)
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

async function run(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "doctor") {
    const info = await managedRuntimeDiagnostics();
    const webPort = Number(Bun.env.EXECUTOR_WEB_PORT ?? 5312);
    const gatewayPort = Number(Bun.env.EXECUTOR_MCP_GATEWAY_PORT ?? 5313);
    const webInstalled = await pathExists(info.webServerEntry);
    const nodeInstalled = await pathExists(info.nodeBin);
    const backendRunning = await checkHttp(`${info.convexUrl}/version`);
    const webRunning = await checkHttp(`http://127.0.0.1:${webPort}/`);
    const gatewayRunning = await checkHttp(`http://127.0.0.1:${gatewayPort}/health`);

    console.log("Managed runtime ready");
    console.log(`  root: ${info.rootDir}`);
    console.log(`  backend: ${info.backendVersion} (${info.backendBinary})`);
    console.log(`  convex URL: ${info.convexUrl}`);
    console.log(`  convex site: ${info.convexSiteUrl}`);
    console.log(`  node runtime: ${nodeInstalled ? info.nodeBin : "not installed yet (installed by 'executor web')"}`);
    console.log(`  web bundle: ${webInstalled ? info.webServerEntry : "not installed yet (installed by 'executor web')"}`);
    console.log(`  web URL: http://127.0.0.1:${webPort}`);
    console.log(`  gateway URL: http://127.0.0.1:${gatewayPort}/mcp`);
    console.log(`  running: backend=${backendRunning ? "yes" : "no"} web=${webRunning ? "yes" : "no"} gateway=${gatewayRunning ? "yes" : "no"}`);
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

  if (command === "gateway") {
    const port = parsePort(rest);
    startMcpGateway(port);
    return;
  }

  if (command === "web") {
    const port = parsePort(rest);
    const exitCode = await runManagedWeb({ port });
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

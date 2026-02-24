#!/usr/bin/env bun

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { managedRuntimeDiagnostics, runManagedBackend, runManagedWeb } from "./packages/core/src/managed-runtime";

interface InstallPaths {
  installDir: string;
  runtimeDir: string;
  homeDir: string;
  serviceDir: string;
  backendPidFile: string;
  webPidFile: string;
}

function installPaths(): InstallPaths {
  const installDir = Bun.env.EXECUTOR_INSTALL_DIR ?? path.join(os.homedir(), ".executor", "bin");
  const runtimeDir = Bun.env.EXECUTOR_RUNTIME_DIR ?? path.join(os.homedir(), ".executor", "runtime");
  const homeDir = Bun.env.EXECUTOR_HOME_DIR ?? path.join(os.homedir(), ".executor");
  const serviceDir = path.join(runtimeDir, "services");
  return {
    installDir,
    runtimeDir,
    homeDir,
    serviceDir,
    backendPidFile: path.join(serviceDir, "backend.pid"),
    webPidFile: path.join(serviceDir, "web.pid"),
  };
}

function printHelp(): void {
  console.log(`Executor CLI

Usage:
  executor doctor [--verbose]
  executor upgrade [--version <version>]
  executor up [backend-args]
  executor claude [--allow-bash] [-- claude-args]
  executor down
  executor backend <args>
  executor web [--port <number>]
  executor uninstall [--yes]

Commands:
  doctor        Show install health and quick status
  upgrade       Re-run installer to update executor
  up            Run managed backend
  claude        Start Claude Code wired to executor MCP execute tool
  down          Stop background backend/web services started by installer
  backend       Pass through arguments to managed convex-local-backend binary
  web           Run packaged web UI (expects backend already running)
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

async function readPid(filePath: string): Promise<number | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }
  const raw = (await fs.readFile(filePath, "utf8")).trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listListeningPids(port: number): Promise<number[]> {
  try {
    const lsof = Bun.spawn(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const lsofExit = await lsof.exited;
    if (lsofExit === 0) {
      const text = await new Response(lsof.stdout).text();
      const fromLsof = text
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      if (fromLsof.length > 0) {
        return fromLsof;
      }
    }
  } catch {
    // lsof may be unavailable in minimal environments
  }

  try {
    const ss = Bun.spawn(["ss", "-ltnp", `( sport = :${port} )`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const ssExit = await ss.exited;
    if (ssExit !== 0) {
      return [];
    }

    const ssText = await new Response(ss.stdout).text();
    const matches = [...ssText.matchAll(/pid=(\d+)/g)];
    const values = matches
      .map((match) => Number(match[1]))
      .filter((value) => Number.isInteger(value) && value > 0);
    return [...new Set(values)];
  } catch {
    return [];
  }
}

async function commandForPid(pid: number): Promise<string> {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return "";
  }
  return (await new Response(proc.stdout).text()).trim();
}

async function filterManagedPids(pids: number[], expected: "backend" | "web"): Promise<number[]> {
  const allowed = expected === "backend"
    ? ["convex-local-backend", "executor", "bun run", "bunx convex"]
    : ["next-server", "server.js", "executor", "node"];

  const result: number[] = [];
  for (const pid of pids) {
    const command = await commandForPid(pid);
    if (allowed.some((needle) => command.includes(needle))) {
      result.push(pid);
    }
  }
  return result;
}

async function terminatePid(pid: number): Promise<boolean> {
  if (!isPidRunning(pid)) {
    return true;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  for (let index = 0; index < 30; index += 1) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await Bun.sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }

  for (let index = 0; index < 20; index += 1) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await Bun.sleep(100);
  }

  return !isPidRunning(pid);
}

async function listProcessEdges(): Promise<Array<{ pid: number; ppid: number }>> {
  const proc = Bun.spawn(["ps", "-eo", "pid=,ppid="], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return [];
  }

  const text = await new Response(proc.stdout).text();
  const edges: Array<{ pid: number; ppid: number }> = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) {
      continue;
    }
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) && ppid >= 0) {
      edges.push({ pid, ppid });
    }
  }

  return edges;
}

async function terminatePidTree(rootPid: number): Promise<boolean> {
  if (!isPidRunning(rootPid)) {
    return true;
  }

  const edges = await listProcessEdges();
  const childrenByParent = new Map<number, number[]>();
  for (const edge of edges) {
    const current = childrenByParent.get(edge.ppid) ?? [];
    current.push(edge.pid);
    childrenByParent.set(edge.ppid, current);
  }

  const stack = [rootPid];
  const collected = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (collected.has(pid)) {
      continue;
    }
    collected.add(pid);
    const children = childrenByParent.get(pid) ?? [];
    for (const child of children) {
      stack.push(child);
    }
  }

  const ordered = [...collected].reverse();
  let stopped = true;
  for (const pid of ordered) {
    stopped = (await terminatePid(pid)) && stopped;
  }
  return stopped;
}

async function stopManagedServices(): Promise<{ backendStopped: boolean; webStopped: boolean }> {
  const paths = installPaths();
  const backendPid = await readPid(paths.backendPidFile);
  const webPid = await readPid(paths.webPidFile);

  let backendStopped = backendPid === null ? true : await terminatePidTree(backendPid);
  let webStopped = webPid === null ? true : await terminatePidTree(webPid);

  const [backendPortPidsRaw, webPortPidsRaw] = await Promise.all([
    listListeningPids(Number(Bun.env.EXECUTOR_BACKEND_PORT ?? 5410)),
    listListeningPids(Number(Bun.env.EXECUTOR_WEB_PORT ?? 5312)),
  ]);
  const [backendPortPids, webPortPids] = await Promise.all([
    filterManagedPids(backendPortPidsRaw, "backend"),
    filterManagedPids(webPortPidsRaw, "web"),
  ]);

  for (const pid of backendPortPids) {
    backendStopped = (await terminatePidTree(pid)) && backendStopped;
  }
  for (const pid of webPortPids) {
    webStopped = (await terminatePidTree(pid)) && webStopped;
  }

  const [remainingBackendPidsRaw, remainingWebPidsRaw] = await Promise.all([
    listListeningPids(Number(Bun.env.EXECUTOR_BACKEND_PORT ?? 5410)),
    listListeningPids(Number(Bun.env.EXECUTOR_WEB_PORT ?? 5312)),
  ]);
  const [remainingBackendPids, remainingWebPids] = await Promise.all([
    filterManagedPids(remainingBackendPidsRaw, "backend"),
    filterManagedPids(remainingWebPidsRaw, "web"),
  ]);

  backendStopped = remainingBackendPids.length === 0;
  webStopped = remainingWebPids.length === 0;

  await fs.rm(paths.backendPidFile, { force: true });
  await fs.rm(paths.webPidFile, { force: true });

  return { backendStopped, webStopped };
}

async function runDown(args: string[]): Promise<number> {
  if (args.length > 0 && args[0] !== "-h" && args[0] !== "--help") {
    console.log(`Unknown option: ${args[0]}`);
    return 1;
  }

  if (args[0] === "-h" || args[0] === "--help") {
    console.log(`Usage:
  executor down

Stops background backend/web services started by the install script.`);
    return 0;
  }

  const result = await stopManagedServices();
  if (!result.backendStopped || !result.webStopped) {
    console.log("Could not stop all managed services cleanly. You may need to stop lingering processes manually.");
    return 1;
  }

  console.log("Managed services stopped.");
  return 0;
}

type FunctionsHealth = {
  state: "ready" | "missing_functions";
  detail?: string;
};

async function checkFunctionsHealth(convexUrl: string): Promise<FunctionsHealth> {
  try {
    const client = new ConvexHttpClient(convexUrl);
    await client.query("app:getClientConfig" as never, {});
    return { state: "ready" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      state: "missing_functions",
      detail,
    };
  }
}

async function runDoctor(args: string[]): Promise<number> {
  const verbose = args.includes("-v") || args.includes("--verbose");
  const runtimeOnly = args.includes("--runtime-only");
  const unknownArgs = args.filter((arg) => arg !== "-v" && arg !== "--verbose" && arg !== "--runtime-only");
  if (unknownArgs.length > 0) {
    console.log(`Unknown option: ${unknownArgs[0]}`);
    return 1;
  }

  const info = await managedRuntimeDiagnostics();
  const webPort = Number(Bun.env.EXECUTOR_WEB_PORT ?? 5312);
  const webInstalled = await pathExists(info.webServerEntry);
  const nodeInstalled = await pathExists(info.nodeBin);
  const backendRunning = await checkHttp(`${info.convexUrl}/version`);
  const webRunning = await checkHttp(`http://127.0.0.1:${webPort}/`);

  let functionsHealth: FunctionsHealth | null = null;
  if (backendRunning && !runtimeOnly) {
    functionsHealth = await checkFunctionsHealth(info.convexUrl);
  }

  const functionsReady = runtimeOnly ? true : functionsHealth?.state === "ready";
  const healthy = nodeInstalled && webInstalled && backendRunning && webRunning && functionsReady;

  console.log(`Executor status: ${healthy ? "ready" : "needs attention"}`);
  console.log(`Dashboard: http://127.0.0.1:${webPort} (${webRunning ? "running" : "not running"})`);
  console.log(`Backend: ${backendRunning ? "running" : "not running"} (${info.convexUrl})`);
  if (runtimeOnly) {
    console.log("Functions: skipped (runtime-only check)");
  } else if (!backendRunning) {
    console.log("Functions: unavailable (backend is not running)");
  } else if (functionsHealth?.state === "ready") {
    console.log("Functions: available");
  } else if (functionsHealth?.state === "missing_functions") {
    console.log("Functions: unavailable (missing deployed functions)");
  } else {
    console.log("Functions: check failed");
  }
  console.log(`MCP endpoint: ${info.convexSiteUrl}/v1/mcp`);

  if (!backendRunning) {
    console.log("Next step: run `executor up`");
  }
  if (!webRunning) {
    console.log("Next step: run `executor web`");
  }
  if (!runtimeOnly && backendRunning && functionsHealth?.state === "missing_functions") {
    console.log("Next step: run `executor up` and inspect ~/.executor/runtime/logs/backend.log");
  }
  if (!webInstalled || !nodeInstalled) {
    console.log("Missing runtime artifacts detected. Re-run install if needed.");
  }

  if (verbose) {
    console.log("");
    console.log("Details:");
    console.log(`  root: ${info.rootDir}`);
    console.log(`  backend: ${info.backendVersion} (${info.backendBinary})`);
    console.log(`  convex URL: ${info.convexUrl}`);
    console.log(`  convex site: ${info.convexSiteUrl}`);
    console.log(`  node runtime: ${nodeInstalled ? info.nodeBin : "missing"}`);
    console.log(`  web bundle: ${webInstalled ? info.webServerEntry : "missing"}`);
    console.log(`  functions: ${runtimeOnly ? "skipped" : (functionsHealth?.state ?? "unavailable")}`);
    if (functionsHealth?.detail) {
      console.log(`  functions detail: ${functionsHealth.detail}`);
    }
    console.log(`  running: backend=${backendRunning ? "yes" : "no"} web=${webRunning ? "yes" : "no"}`);
    console.log(`  config: ${info.configPath}`);
  }

  return healthy ? 0 : 1;
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

  const paths = installPaths();

  if (!assumeYes) {
    console.log("This will remove:");
    console.log(`  - ${paths.installDir}/executor`);
    console.log(`  - ${paths.runtimeDir}`);
    const response = prompt("Continue? [y/N] ");
    if (response === null || response.toLowerCase() !== "y") {
      console.log("Cancelled.");
      return 0;
    }
  }

  const stopResult = await stopManagedServices();
  if (!stopResult.backendStopped || !stopResult.webStopped) {
    console.warn("executor: some managed services did not stop cleanly before uninstall");
  }

  await fs.rm(path.join(paths.installDir, "executor"), { force: true });
  await fs.rm(paths.runtimeDir, { recursive: true, force: true });

  if (await pathExists(paths.installDir)) {
    try {
      await fs.rmdir(paths.installDir);
    } catch {
      // keep if it is not empty
    }
  }

  if (await pathExists(paths.homeDir)) {
    try {
      await fs.rmdir(paths.homeDir);
    } catch {
      // keep if other files remain
    }
  }

  console.log("Executor uninstall complete.");
  console.log("");
  console.log("If you previously added PATH manually, remove this line from your shell rc:");
  console.log(`  export PATH=${paths.installDir}:$PATH`);
  return 0;
}

async function runUpgrade(args: string[]): Promise<number> {
  let requestedVersion: string | undefined;
  let noModifyPath = false;
  let noStarPrompt = false;
  let index = 0;

  while (index < args.length) {
    const arg = args[index];

    if (arg === "-h" || arg === "--help") {
      console.log(`Usage:
  executor upgrade [--version <version>] [--no-modify-path] [--no-star-prompt]

Aliases:
  executor update

Options:
  -v, --version <version>  Install specific release version
  --no-modify-path         Do not modify shell PATH entries
  --no-star-prompt         Do not print GitHub star prompt
  -h, --help               Show this help`);
      return 0;
    }

    if (arg === "-v" || arg === "--version") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        console.log("Missing value for --version");
        return 1;
      }
      requestedVersion = value;
      index += 2;
      continue;
    }

    if (arg === "--no-modify-path") {
      noModifyPath = true;
      index += 1;
      continue;
    }

    if (arg === "--no-star-prompt") {
      noStarPrompt = true;
      index += 1;
      continue;
    }

    console.log(`Unknown option: ${arg}`);
    return 1;
  }

  const installUrl = Bun.env.EXECUTOR_INSTALL_URL ?? "https://executor.sh/install";
  console.log(`[executor] upgrading via ${installUrl}`);

  const response = await fetch(installUrl);
  if (!response.ok) {
    throw new Error(`Failed to download installer: ${response.status} ${response.statusText}`);
  }

  const script = await response.text();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-upgrade-"));
  const scriptPath = path.join(tempDir, "install.sh");

  try {
    await fs.writeFile(scriptPath, script, "utf8");
    await fs.chmod(scriptPath, 0o755);

    const installerArgs: string[] = [];
    if (requestedVersion) {
      installerArgs.push("--version", requestedVersion);
    }
    if (noModifyPath) {
      installerArgs.push("--no-modify-path");
    }
    if (noStarPrompt) {
      installerArgs.push("--no-star-prompt");
    }

    const proc = Bun.spawn(["bash", scriptPath, ...installerArgs], {
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await proc.exited;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

type AnonymousTokenResponse = {
  accessToken: string;
  accountId: string;
  expiresAtMs: number;
};

type AnonymousSessionContext = {
  sessionId: string;
  workspaceId: string;
};

type McpApiKeyResponse = {
  enabled: boolean;
  apiKey: string | null;
  error?: string;
};

type ClaudeLaunchContext = {
  mcpUrl: string;
  apiKey: string;
};

const CLAUDE_SESSION_FILE = "claude-session-id";
const CLAUDE_SYSTEM_PROMPT = "Use mcp__executor__execute for command-like work and code execution. That tool runs TypeScript inside executor's sandbox.";

async function readStoredClaudeSessionId(runtimeRoot: string): Promise<string | undefined> {
  const filePath = path.join(runtimeRoot, CLAUDE_SESSION_FILE);
  try {
    const value = (await fs.readFile(filePath, "utf8")).trim();
    if (value.startsWith("mcp_")) {
      return value;
    }
  } catch {
    // missing file is expected on first run
  }

  return undefined;
}

async function writeStoredClaudeSessionId(runtimeRoot: string, sessionId: string): Promise<void> {
  if (!sessionId.startsWith("mcp_")) {
    return;
  }

  const filePath = path.join(runtimeRoot, CLAUDE_SESSION_FILE);
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.writeFile(filePath, `${sessionId}\n`, { encoding: "utf8", mode: 0o600 });
}

async function requestAnonymousToken(convexSiteUrl: string): Promise<AnonymousTokenResponse> {
  const response = await fetch(`${convexSiteUrl}/auth/anonymous/token`, {
    method: "POST",
  });

  const responseText = await response.text();
  if (!response.ok) {
    const detail = responseText.trim().length > 0 ? responseText.trim() : `${response.status} ${response.statusText}`;
    throw new Error(`Failed to obtain anonymous auth token: ${detail}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("Anonymous token response was not valid JSON");
  }

  const parsed = payload as Partial<AnonymousTokenResponse>;
  if (
    typeof parsed.accessToken !== "string"
    || typeof parsed.accountId !== "string"
    || typeof parsed.expiresAtMs !== "number"
  ) {
    throw new Error("Anonymous token response was malformed");
  }

  return {
    accessToken: parsed.accessToken,
    accountId: parsed.accountId,
    expiresAtMs: parsed.expiresAtMs,
  };
}

async function bootstrapClaudeContext(convexUrl: string, convexSiteUrl: string, runtimeRoot: string): Promise<ClaudeLaunchContext> {
  const token = await requestAnonymousToken(convexSiteUrl);

  const convex = new ConvexHttpClient(convexUrl, {
    skipConvexDeploymentUrlCheck: true,
  });
  convex.setAuth(token.accessToken);
  const convexAny = convex as unknown as {
    mutation: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    query: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };

  const storedSessionId = await readStoredClaudeSessionId(runtimeRoot);
  const anonymousContext = await convexAny.mutation("workspace:bootstrapAnonymousSession", {
    ...(storedSessionId ? { sessionId: storedSessionId } : {}),
  }) as AnonymousSessionContext;

  if (typeof anonymousContext?.sessionId !== "string" || typeof anonymousContext?.workspaceId !== "string") {
    throw new Error("Anonymous session bootstrap returned malformed data");
  }

  await writeStoredClaudeSessionId(runtimeRoot, anonymousContext.sessionId);

  const mcpApiKey = await convexAny.query("workspace:getMcpApiKey", {
    workspaceId: anonymousContext.workspaceId,
    sessionId: anonymousContext.sessionId,
  }) as McpApiKeyResponse;

  if (!mcpApiKey.enabled || !mcpApiKey.apiKey) {
    throw new Error(mcpApiKey.error ?? "MCP API key is not available");
  }

  const mcpUrl = new URL("/v1/mcp/anonymous", convexSiteUrl);
  mcpUrl.searchParams.set("workspaceId", anonymousContext.workspaceId);

  return {
    mcpUrl: mcpUrl.toString(),
    apiKey: mcpApiKey.apiKey,
  };
}

function printClaudeHelp(): void {
  console.log(`Usage:
  executor claude [--allow-bash] [-- claude-args]

Starts Claude Code with a temporary MCP config wired to executor's execute tool.

Options:
  --allow-bash    Keep Claude's Bash tool enabled
  -h, --help      Show this help

Examples:
  executor claude
  executor claude -- "fix failing tests"
  executor claude --allow-bash -- --model sonnet`);
}

async function runClaude(args: string[]): Promise<number> {
  const claudePath = Bun.which("claude");
  if (!claudePath) {
    console.log("Claude Code CLI is not installed. Install it first with:");
    console.log("  curl -fsSL https://claude.ai/install.sh | bash");
    return 1;
  }

  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    printClaudeHelp();
    return 0;
  }

  let allowBash = false;
  let passThrough = args;

  if (passThrough[0] !== "--") {
    passThrough = passThrough.filter((arg) => {
      if (arg === "--allow-bash") {
        allowBash = true;
        return false;
      }
      return true;
    });
  }

  if (passThrough[0] === "--") {
    passThrough = passThrough.slice(1);
  }

  const info = await managedRuntimeDiagnostics();
  const backendRunning = await checkHttp(`${info.convexUrl}/version`);
  if (!backendRunning) {
    console.log("Managed backend is not running. Start it first with `executor up`.");
    return 1;
  }

  const launchContext = await bootstrapClaudeContext(info.convexUrl, info.convexSiteUrl, info.rootDir);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-claude-"));
  const configPath = path.join(tempDir, "mcp.json");
  const mcpConfig = {
    mcpServers: {
      executor: {
        type: "http",
        url: launchContext.mcpUrl,
        headers: {
          "x-api-key": launchContext.apiKey,
        },
      },
    },
  };

  try {
    await fs.writeFile(configPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const claudeArgs: string[] = [
      "--mcp-config",
      configPath,
      "--strict-mcp-config",
      "--append-system-prompt",
      CLAUDE_SYSTEM_PROMPT,
      ...(!allowBash ? ["--disallowedTools", "Bash"] : []),
      ...passThrough,
    ];

    const proc = Bun.spawn([claudePath, ...claudeArgs], {
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await proc.exited;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "doctor") {
    const exitCode = await runDoctor(rest);
    process.exit(exitCode);
  }

  if (command === "upgrade" || command === "update") {
    const exitCode = await runUpgrade(rest);
    process.exit(exitCode);
  }

  if (command === "down" || command === "stop") {
    const exitCode = await runDown(rest);
    process.exit(exitCode);
  }

  if (command === "up") {
    const exitCode = await runManagedBackend(rest);
    process.exit(exitCode);
  }

  if (command === "claude") {
    const exitCode = await runClaude(rest);
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

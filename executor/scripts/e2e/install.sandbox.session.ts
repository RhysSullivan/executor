import { Sandbox } from "@vercel/sandbox";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected ${name} to be a positive integer, got: ${raw}`);
  }

  return parsed;
}

function sandboxCredentials(): { token: string; teamId: string; projectId: string } | Record<never, never> {
  if (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID) {
    return {
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    };
  }

  return {};
}

async function runSandboxBash(
  sandbox: Sandbox,
  script: string,
  options: {
    timeoutMs: number;
    env?: Record<string, string>;
  },
): Promise<CommandResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  try {
    const command = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", script],
      env: options.env,
      signal: controller.signal,
    });

    const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()]);
    return {
      exitCode: command.exitCode,
      stdout,
      stderr,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function assertSuccess(result: CommandResult, label: string): void {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    [
      `${label} failed with exit code ${result.exitCode}`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`,
    ].join("\n\n"),
  );
}

const backendPort = parseIntegerEnv("EXECUTOR_BACKEND_PORT", 5410);
const sitePort = parseIntegerEnv("EXECUTOR_BACKEND_SITE_PORT", 5411);
const webPort = parseIntegerEnv("EXECUTOR_WEB_PORT", 5312);
const sandboxTimeoutMs = parseIntegerEnv("EXECUTOR_SANDBOX_TIMEOUT_MS", 30 * 60 * 1000);
const installTimeoutMs = parseIntegerEnv("EXECUTOR_SANDBOX_INSTALL_TIMEOUT_MS", 15 * 60 * 1000);

let sandbox: Sandbox | null = null;

try {
  sandbox = await Sandbox.create({
    runtime: "node22",
    ports: [webPort, backendPort, sitePort],
    timeout: sandboxTimeoutMs,
    ...sandboxCredentials(),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Could not create Vercel sandbox. Configure auth via VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID or VERCEL_OIDC_TOKEN.\n\n${message}`,
  );
}

try {
  console.log(`[sandbox] created: ${sandbox.sandboxId}`);
  console.log("[sandbox] running executor.sh install flow...");

  const install = await runSandboxBash(
    sandbox,
    [
      "set -euo pipefail",
      "cd ~",
      "if [ -x ~/.executor/bin/executor ]; then ~/.executor/bin/executor uninstall --yes || true; fi",
      "rm -rf ~/.executor",
      "curl -fsSL https://executor.sh/install | bash -s -- --no-modify-path --no-star-prompt",
      "~/.executor/bin/executor doctor --verbose",
    ].join("; "),
    {
      timeoutMs: installTimeoutMs,
      env: {
        EXECUTOR_BACKEND_INTERFACE: "0.0.0.0",
        EXECUTOR_WEB_INTERFACE: "0.0.0.0",
        EXECUTOR_BACKEND_PORT: String(backendPort),
        EXECUTOR_BACKEND_SITE_PORT: String(sitePort),
        EXECUTOR_WEB_PORT: String(webPort),
      },
    },
  );
  assertSuccess(install, "sandbox install + doctor");

  const webUrl = sandbox.domain(webPort);
  const convexUrl = sandbox.domain(backendPort);
  const convexSiteUrl = sandbox.domain(sitePort);

  console.log("");
  console.log("Sandbox is ready for manual testing.");
  console.log(`Sandbox ID: ${sandbox.sandboxId}`);
  console.log(`Web UI: ${webUrl}`);
  console.log(`Convex API: ${convexUrl}`);
  console.log(`Convex Site: ${convexSiteUrl}`);
  console.log(`MCP (auth): ${convexSiteUrl}/mcp`);
  console.log(`MCP (anonymous): ${convexSiteUrl}/mcp/anonymous`);
  console.log("");
  console.log("The sandbox is left running so you can test from your machine.");
  console.log("Stop it from Vercel when you are done, or wait for sandbox timeout.");
} catch (error) {
  if (sandbox) {
    try {
      await sandbox.stop();
      console.error("[sandbox] install failed; sandbox has been stopped.");
    } catch {
      console.error("[sandbox] install failed and sandbox cleanup also failed.");
    }
  }
  throw error;
}

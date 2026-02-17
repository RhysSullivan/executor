import { Sandbox } from "@vercel/sandbox";
import { generateKeyPairSync } from "node:crypto";
import { anonymousBootstrapCheckScript, runtimeDoctorScript } from "./install-checks";

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

function normalizePemForEnv(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n/g, "\\n").trim();
}

function resolveAnonymousAuthEnv(): {
  privateKeyPem: string;
  publicKeyPem: string;
  apiKeySecret: string;
  generated: boolean;
} {
  const privateFromEnv = process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM?.trim();
  const publicFromEnv = process.env.ANONYMOUS_AUTH_PUBLIC_KEY_PEM?.trim();
  const apiKeyFromEnv = process.env.MCP_API_KEY_SECRET?.trim();

  if (privateFromEnv && publicFromEnv) {
    return {
      privateKeyPem: normalizePemForEnv(privateFromEnv),
      publicKeyPem: normalizePemForEnv(publicFromEnv),
      apiKeySecret: apiKeyFromEnv && apiKeyFromEnv.length > 0 ? apiKeyFromEnv : normalizePemForEnv(privateFromEnv),
      generated: false,
    };
  }

  const keyPair = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
  });

  const privateKeyPem = normalizePemForEnv(keyPair.privateKey);
  const publicKeyPem = normalizePemForEnv(keyPair.publicKey);

  return {
    privateKeyPem,
    publicKeyPem,
    apiKeySecret: apiKeyFromEnv && apiKeyFromEnv.length > 0 ? apiKeyFromEnv : privateKeyPem,
    generated: true,
  };
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

function extractInstalledVersion(result: CommandResult): string | null {
  const output = `${result.stdout}\n${result.stderr}`;
  const match = output.match(/Installing executor v([^\s]+)/);
  return match?.[1] ?? null;
}

function extractSemver(result: CommandResult): string | null {
  const output = `${result.stdout}\n${result.stderr}`;
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

function sandboxRuntimeEnv(backendPort: number, sitePort: number, webPort: number): Record<string, string> {
  return {
    EXECUTOR_BACKEND_INTERFACE: "0.0.0.0",
    EXECUTOR_WEB_INTERFACE: "0.0.0.0",
    EXECUTOR_BACKEND_PORT: String(backendPort),
    EXECUTOR_BACKEND_SITE_PORT: String(sitePort),
    EXECUTOR_WEB_PORT: String(webPort),
  };
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
  const webUrl = sandbox.domain(webPort);
  const convexUrl = sandbox.domain(backendPort);
  const convexSiteUrl = sandbox.domain(sitePort);
  const sandboxEnv = {
    ...sandboxRuntimeEnv(backendPort, sitePort, webPort),
    CONVEX_URL: convexUrl,
    CONVEX_SITE_URL: convexSiteUrl,
    EXECUTOR_WEB_CONVEX_URL: convexUrl,
    EXECUTOR_WEB_CONVEX_SITE_URL: convexSiteUrl,
  };

  console.log(`[sandbox] created: ${sandbox.sandboxId}`);
  console.log("[sandbox] running executor.sh install flow...");

  const anonymousAuthEnv = resolveAnonymousAuthEnv();
  if (anonymousAuthEnv.generated) {
    console.log("[sandbox] generated ephemeral anonymous auth keys for this session");
  }

  const install = await runSandboxBash(
    sandbox,
    [
      "set -euo pipefail",
      "cd ~",
      "if [ -x ~/.executor/bin/executor ]; then ~/.executor/bin/executor uninstall --yes || true; fi",
      "rm -rf ~/.executor",
      "curl -fsSL https://executor.sh/install | bash -s -- --no-modify-path --no-star-prompt",
    ].join("; "),
    {
      timeoutMs: installTimeoutMs,
      env: {
        ...sandboxEnv,
        ANONYMOUS_AUTH_PRIVATE_KEY_PEM: anonymousAuthEnv.privateKeyPem,
        ANONYMOUS_AUTH_PUBLIC_KEY_PEM: anonymousAuthEnv.publicKeyPem,
        MCP_API_KEY_SECRET: anonymousAuthEnv.apiKeySecret,
      },
    },
  );
  assertSuccess(install, "sandbox install");

  const installedVersion = extractSemver(install) ?? extractInstalledVersion(install);
  if (installedVersion) {
    console.log(`[sandbox] installed executor version: v${installedVersion}`);
  } else {
    console.warn("[sandbox] could not determine installed executor version from installer output");
  }

  const runtimeDoctor = await runSandboxBash(
    sandbox,
    runtimeDoctorScript(),
    {
      timeoutMs: installTimeoutMs,
      env: sandboxEnv,
    },
  );
  assertSuccess(runtimeDoctor, "sandbox doctor --runtime-only");

  const doctor = await runSandboxBash(
    sandbox,
    "~/.executor/bin/executor doctor --verbose",
    {
      timeoutMs: installTimeoutMs,
      env: sandboxEnv,
    },
  );
  assertSuccess(doctor, "sandbox doctor --verbose");

  const anonymousCheck = await runSandboxBash(
    sandbox,
    anonymousBootstrapCheckScript({ backendPort, webPort }),
    {
      timeoutMs: installTimeoutMs,
      env: sandboxEnv,
    },
  );
  assertSuccess(anonymousCheck, "sandbox anonymous account flow");
  console.log("[sandbox] anonymous token + bootstrap session flow verified");

  console.log("");
  console.log("Sandbox is ready for manual testing.");
  console.log(`Sandbox ID: ${sandbox.sandboxId}`);
  console.log(`Web UI: ${webUrl}`);
  console.log(`Convex API: ${convexUrl}`);
  console.log(`Convex Site: ${convexSiteUrl}`);
  console.log(`MCP (auth): ${convexSiteUrl}/mcp`);
  console.log(`MCP (anonymous): ${convexSiteUrl}/mcp/anonymous`);
  console.log("Tip: open Web UI and create an anonymous organization to get workspace context + API key.");
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

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseConvexEnvList } from "../doctor-prod";

interface Options {
  runUrl?: string;
  convexUrl?: string;
  authToken?: string;
  internalToken?: string;
  deploy: boolean;
  runDoctor: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const EXECUTOR_ROOT = path.resolve(import.meta.dir, "..", "..");
const SANDBOX_HOST_DIR = path.join(EXECUTOR_ROOT, "packages", "runner-sandbox-host");

function printHelp(): void {
  console.log(`Setup Cloudflare runtime for production

Usage:
  bun run scripts/prod/setup/prod-cloudflare.ts [options]

Options:
  --run-url <url>          Explicit sandbox run URL (e.g. https://.../v1/runs)
  --convex-url <url>       Explicit Convex API URL (https://...convex.cloud)
  --auth-token <token>     Explicit sandbox auth token (otherwise generated)
  --internal-token <token> Explicit internal callback token (otherwise generated)
  --no-deploy              Skip wrangler deploy step
  --no-doctor              Skip running doctor:prod at the end
  -h, --help               Show this help
`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    deploy: true,
    runDoctor: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--run-url") {
      if (!next) throw new Error("Missing value for --run-url");
      options.runUrl = next;
      i += 1;
      continue;
    }
    if (arg === "--convex-url") {
      if (!next) throw new Error("Missing value for --convex-url");
      options.convexUrl = next;
      i += 1;
      continue;
    }
    if (arg === "--auth-token") {
      if (!next) throw new Error("Missing value for --auth-token");
      options.authToken = next;
      i += 1;
      continue;
    }
    if (arg === "--internal-token") {
      if (!next) throw new Error("Missing value for --internal-token");
      options.internalToken = next;
      i += 1;
      continue;
    }
    if (arg === "--no-deploy") {
      options.deploy = false;
      continue;
    }
    if (arg === "--no-doctor") {
      options.runDoctor = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function redact(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function runCommand(
  command: string[],
  opts: { cwd?: string; stdinData?: string } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    cwd: opts.cwd ?? EXECUTOR_ROOT,
    env: Bun.env,
    stdin: opts.stdinData !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (opts.stdinData !== undefined && proc.stdin) {
    proc.stdin.write(`${opts.stdinData}\n`);
    proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    exitCode,
    stdout,
    stderr,
  };
}

async function runConvex(args: string[]): Promise<CommandResult> {
  return await runCommand(["bunx", "convex", ...args]);
}

function ensureHttpsUrl(name: string, raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${raw}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must use https: ${raw}`);
  }
}

async function parseSandboxWorkerName(): Promise<string> {
  const wranglerConfigPath = path.join(SANDBOX_HOST_DIR, "wrangler.jsonc");
  const text = await fs.readFile(wranglerConfigPath, "utf8");
  const match = text.match(/"name"\s*:\s*"([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(`Could not parse worker name from ${wranglerConfigPath}`);
  }
  return match[1];
}

function inferWorkersUrlFromDeployOutput(output: string): string | null {
  const match = output.match(/https:\/\/[a-zA-Z0-9._-]+\.workers\.dev/);
  if (!match?.[0]) {
    return null;
  }
  return `${match[0]}/v1/runs`;
}

async function deploySandboxHostIfNeeded(enabled: boolean): Promise<string | null> {
  if (!enabled) {
    return null;
  }

  console.log("[setup] deploying sandbox host worker...");
  const deploy = await runCommand(["bunx", "wrangler", "deploy"], { cwd: SANDBOX_HOST_DIR });
  if (deploy.exitCode !== 0) {
    throw new Error(`wrangler deploy failed:\n${deploy.stderr || deploy.stdout}`);
  }

  const combined = `${deploy.stdout}\n${deploy.stderr}`;
  const inferred = inferWorkersUrlFromDeployOutput(combined);
  if (inferred) {
    console.log(`[setup] inferred run URL from deploy output: ${inferred}`);
  }
  return inferred;
}

async function putWorkerSecret(secretName: string, value: string): Promise<void> {
  const workerName = await parseSandboxWorkerName();
  console.log(`[setup] setting wrangler secret ${secretName} on ${workerName}...`);

  const result = await runCommand(
    ["bunx", "wrangler", "secret", "put", secretName, "--name", workerName],
    { cwd: SANDBOX_HOST_DIR, stdinData: value },
  );
  if (result.exitCode !== 0) {
    throw new Error(`wrangler secret put ${secretName} failed:\n${result.stderr || result.stdout}`);
  }
}

async function setConvexEnv(key: string, value: string): Promise<void> {
  const result = await runConvex(["env", "set", key, value, "--prod"]);
  if (result.exitCode !== 0) {
    throw new Error(`convex env set ${key} failed:\n${result.stderr || result.stdout}`);
  }
}

async function getProdEnvMap(): Promise<Map<string, string>> {
  const envResult = await runConvex(["env", "list", "--prod"]);
  if (envResult.exitCode !== 0) {
    throw new Error(`convex env list --prod failed:\n${envResult.stderr || envResult.stdout}`);
  }
  return parseConvexEnvList(envResult.stdout);
}

function resolveConvexUrl(options: Options, env: Map<string, string>): string {
  const selected = options.convexUrl?.trim()
    || env.get("CONVEX_URL")?.trim()
    || Bun.env.CONVEX_URL?.trim();

  if (!selected) {
    throw new Error(
      "Could not determine CONVEX_URL. Pass --convex-url or set CONVEX_URL in your environment.",
    );
  }

  ensureHttpsUrl("CONVEX_URL", selected);
  return selected;
}

function resolveRunUrl(options: Options, env: Map<string, string>, deployedRunUrl: string | null): string {
  const selected = options.runUrl?.trim()
    || deployedRunUrl
    || env.get("CLOUDFLARE_SANDBOX_RUN_URL")?.trim();

  if (!selected) {
    throw new Error(
      "Could not determine CLOUDFLARE_SANDBOX_RUN_URL. Pass --run-url or allow deploy to infer it.",
    );
  }

  ensureHttpsUrl("CLOUDFLARE_SANDBOX_RUN_URL", selected);
  if (!selected.includes("/v1/runs")) {
    throw new Error(`CLOUDFLARE_SANDBOX_RUN_URL must include /v1/runs: ${selected}`);
  }
  return selected;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const env = await getProdEnvMap();

  const deployedRunUrl = await deploySandboxHostIfNeeded(options.deploy);

  const runUrl = resolveRunUrl(options, env, deployedRunUrl);
  const convexUrl = resolveConvexUrl(options, env);
  const authToken = options.authToken?.trim() || env.get("CLOUDFLARE_SANDBOX_AUTH_TOKEN")?.trim() || randomToken();
  const internalToken = options.internalToken?.trim() || env.get("EXECUTOR_INTERNAL_TOKEN")?.trim() || randomToken();

  await putWorkerSecret("AUTH_TOKEN", authToken);

  console.log("[setup] setting production Convex env vars...");
  await setConvexEnv("CLOUDFLARE_SANDBOX_RUN_URL", runUrl);
  await setConvexEnv("CLOUDFLARE_SANDBOX_AUTH_TOKEN", authToken);
  await setConvexEnv("EXECUTOR_INTERNAL_TOKEN", internalToken);
  await setConvexEnv("CONVEX_URL", convexUrl);

  console.log("\n[setup] cloudflare production runtime configured");
  console.log(`  CLOUDFLARE_SANDBOX_RUN_URL: ${runUrl}`);
  console.log(`  CLOUDFLARE_SANDBOX_AUTH_TOKEN: ${redact(authToken)}`);
  console.log(`  EXECUTOR_INTERNAL_TOKEN: ${redact(internalToken)}`);
  console.log(`  CONVEX_URL: ${convexUrl}`);

  if (options.runDoctor) {
    console.log("\n[setup] running doctor:prod...");
    const doctor = await runCommand(["bun", "run", "doctor:prod"], { cwd: EXECUTOR_ROOT });
    const output = [doctor.stdout.trim(), doctor.stderr.trim()].filter(Boolean).join("\n");
    if (output) {
      console.log(output);
    }
    if (doctor.exitCode !== 0) {
      process.exit(doctor.exitCode);
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[setup] failed: ${message}`);
  process.exit(1);
}

import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseConvexEnvList } from "./doctor-prod";

type StepId = "cloudflare" | "env" | "convex" | "doctor";

interface Options {
  apply: boolean;
  yes: boolean;
  force: boolean;
  only?: Set<StepId>;
  skip: Set<StepId>;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PreflightCheck {
  id: string;
  ok: boolean;
  detail: string;
  hint?: string;
  blocking: boolean;
}

interface DeployStep {
  id: StepId;
  name: string;
  command: string[];
  cwd?: string;
}

const EXECUTOR_ROOT = path.resolve(import.meta.dir, "..");
const RUNNER_HOST_DIR = path.join(EXECUTOR_ROOT, "packages", "runner-sandbox-host");

const ALL_STEPS: StepId[] = ["cloudflare", "env", "convex", "doctor"];
const REQUIRED_ENV_SETUP_KEYS = [
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "WORKOS_WEBHOOK_SECRET",
  "WORKOS_COOKIE_PASSWORD",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID",
  "MCP_AUTHORIZATION_SERVER",
] as const;

function printHelp(): void {
  console.log(`Guided production deploy for executor

Usage:
  bun run scripts/deploy-prod.ts [options]

Options:
  --apply                Execute steps (default is plan only)
  --yes                  Skip confirmation prompts
  --force                Continue apply even if preflight has blocking failures
  --only <steps>         Run only these steps (comma-separated)
  --skip <steps>         Skip these steps (comma-separated)
  -h, --help             Show this help

Steps:
  cloudflare             Configure sandbox host worker + runtime env wiring
  env                    Sync WorkOS/Stripe/auth env to Convex prod
  convex                 Deploy Convex functions to prod
  doctor                 Verify prod setup and print remediation

Examples:
  bun run scripts/deploy-prod.ts
  bun run scripts/deploy-prod.ts --apply
  bun run scripts/deploy-prod.ts --apply --only cloudflare,doctor
  bun run scripts/deploy-prod.ts --apply --skip convex --yes
`);
}

function parseStepSet(raw: string): Set<StepId> {
  const set = new Set<StepId>();
  for (const token of raw.split(",")) {
    const value = token.trim();
    if (!value) continue;
    if (!ALL_STEPS.includes(value as StepId)) {
      throw new Error(`Unknown step '${value}'. Valid steps: ${ALL_STEPS.join(", ")}`);
    }
    set.add(value as StepId);
  }
  return set;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    yes: false,
    force: false,
    skip: new Set<StepId>(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--yes") {
      options.yes = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--only") {
      if (!next) throw new Error("Missing value for --only");
      options.only = parseStepSet(next);
      i += 1;
      continue;
    }
    if (arg === "--skip") {
      if (!next) throw new Error("Missing value for --skip");
      options.skip = parseStepSet(next);
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown option '${arg}'. Use --help for usage.`);
  }

  return options;
}

export function resolveSteps(options: Options): StepId[] {
  const only = options.only ?? new Set<StepId>(ALL_STEPS);
  return ALL_STEPS.filter((step) => only.has(step) && !options.skip.has(step));
}

async function runCommand(command: string[], cwd = EXECUTOR_ROOT): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    cwd,
    env: Bun.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

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

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function buildSteps(selected: StepId[]): DeployStep[] {
  const byId: Record<StepId, DeployStep> = {
    cloudflare: {
      id: "cloudflare",
      name: "Cloudflare Runtime",
      command: ["bun", "run", "scripts/setup-prod-cloudflare.ts", "--deploy", "--no-doctor"],
      cwd: EXECUTOR_ROOT,
    },
    env: {
      id: "env",
      name: "Convex Env Sync",
      command: ["bun", "run", "scripts/setup-prod-env.ts", "--from-env", "--strict"],
      cwd: EXECUTOR_ROOT,
    },
    convex: {
      id: "convex",
      name: "Convex Deploy",
      command: ["bunx", "convex", "deploy", "--prod"],
      cwd: EXECUTOR_ROOT,
    },
    doctor: {
      id: "doctor",
      name: "Production Doctor",
      command: ["bun", "run", "scripts/doctor-prod.ts"],
      cwd: EXECUTOR_ROOT,
    },
  };

  return selected.map((step) => byId[step]);
}

async function getConvexProdEnv(): Promise<Map<string, string>> {
  const result = await runCommand(["bunx", "convex", "env", "list", "--prod"]);
  if (result.exitCode !== 0) {
    return new Map<string, string>();
  }
  return parseConvexEnvList(result.stdout);
}

function missingLocalEnvKeys(): string[] {
  return REQUIRED_ENV_SETUP_KEYS.filter((key) => !Bun.env[key]?.trim());
}

async function runPreflight(selected: StepId[]): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const usesCloudflare = selected.includes("cloudflare");
  const usesConvex = selected.some((id) => id === "env" || id === "convex" || id === "doctor" || id === "cloudflare");

  if (usesCloudflare) {
    const whoami = await runCommand(["bunx", "wrangler", "whoami"], RUNNER_HOST_DIR);
    checks.push({
      id: "wrangler-auth",
      ok: whoami.exitCode === 0,
      blocking: true,
      detail: whoami.exitCode === 0 ? "Wrangler auth is available" : "Wrangler auth not available",
      hint: whoami.exitCode === 0 ? undefined : "Run `bunx wrangler login` and retry.",
    });
  }

  if (usesConvex) {
    const convexEnv = await runCommand(["bunx", "convex", "env", "list", "--prod"]);
    checks.push({
      id: "convex-auth",
      ok: convexEnv.exitCode === 0,
      blocking: true,
      detail: convexEnv.exitCode === 0 ? "Convex prod env is accessible" : "Cannot access Convex prod env",
      hint: convexEnv.exitCode === 0 ? undefined : "Run `bunx convex dev` or `bunx convex login` to authenticate.",
    });
  }

  if (selected.includes("env")) {
    const missing = missingLocalEnvKeys();
    checks.push({
      id: "env-local-values",
      ok: missing.length === 0,
      blocking: true,
      detail: missing.length === 0
        ? "All required local env vars for setup:prod:env are present"
        : `Missing local env vars: ${missing.join(", ")}`,
      hint: missing.length === 0
        ? undefined
        : "Export required WORKOS_*, STRIPE_*, and MCP_AUTHORIZATION_SERVER vars before apply.",
    });
  }

  if (selected.includes("cloudflare")) {
    const env = await getConvexProdEnv();
    const hasConvexUrl = Boolean(Bun.env.CONVEX_URL?.trim() || env.get("CONVEX_URL")?.trim());
    checks.push({
      id: "convex-url",
      ok: hasConvexUrl,
      blocking: true,
      detail: hasConvexUrl ? "CONVEX_URL is available" : "CONVEX_URL not found locally or in Convex prod env",
      hint: hasConvexUrl
        ? undefined
        : "Set with `export CONVEX_URL=https://<deployment>.convex.cloud` or `bunx convex env set CONVEX_URL ... --prod`.",
    });
  }

  if (selected.includes("convex") && isTruthy(Bun.env.IAC_MANAGE_CONVEX_ENV) && !selected.includes("env")) {
    checks.push({
      id: "convex-env-order",
      ok: true,
      blocking: false,
      detail: "Convex deploy selected without env sync",
      hint: "If you changed env vars, run with `--only env,convex,doctor` for safer ordering.",
    });
  }

  return checks;
}

function printPlan(steps: DeployStep[], checks: PreflightCheck[]): void {
  console.log("Deploy plan");
  for (const step of steps) {
    console.log(`  - ${step.id}: ${step.name}`);
    console.log(`      ${step.command.join(" ")}`);
  }

  console.log("\nPreflight");
  for (const check of checks) {
    const label = check.ok ? "ok" : (check.blocking ? "fail" : "warn");
    console.log(`  [${label}] ${check.id}: ${check.detail}`);
    if (check.hint) {
      console.log(`      hint: ${check.hint}`);
    }
  }
}

async function confirmApply(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const input = (await rl.question("\nProceed with apply? [y/N] ")).trim().toLowerCase();
  rl.close();
  return input === "y" || input === "yes";
}

async function executeSteps(steps: DeployStep[]): Promise<void> {
  for (const step of steps) {
    console.log(`\n==> ${step.name}`);
    const result = await runCommand(step.command, step.cwd ?? EXECUTOR_ROOT);

    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    if (result.exitCode !== 0) {
      throw new Error(`Step '${step.id}' failed with exit code ${result.exitCode}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const selected = resolveSteps(options);
  if (selected.length === 0) {
    throw new Error("No steps selected. Remove --skip/--only filters.");
  }

  const steps = buildSteps(selected);
  const checks = await runPreflight(selected);
  const blockingFailures = checks.filter((check) => !check.ok && check.blocking);

  console.log("Executor production deploy");
  console.log(`Mode: ${options.apply ? "apply" : "plan"}`);
  printPlan(steps, checks);

  if (!options.apply) {
    console.log("\nPlan only. Re-run with --apply to execute.");
    return;
  }

  if (blockingFailures.length > 0 && !options.force) {
    throw new Error("Blocking preflight failures detected. Fix them or use --force to override.");
  }

  if (!options.yes) {
    const approved = await confirmApply();
    if (!approved) {
      console.log("Aborted.");
      return;
    }
  }

  await executeSteps(steps);
  console.log("\nDeploy completed.");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`deploy:prod failed: ${message}`);
    process.exit(1);
  }
}

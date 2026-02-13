import path from "node:path";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProductionDoctorReport {
  checks: DoctorCheck[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const REQUIRED_PROD_ENV_KEYS = [
  "CLOUDFLARE_SANDBOX_RUN_URL",
  "CLOUDFLARE_SANDBOX_AUTH_TOKEN",
  "EXECUTOR_INTERNAL_TOKEN",
  "EXECUTOR_CLOUDFLARE_DYNAMIC_WORKER_ONLY",
  "CONVEX_URL",
] as const;

const REQUIRED_APP_ENV_KEYS = [
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "WORKOS_WEBHOOK_SECRET",
  "WORKOS_COOKIE_PASSWORD",
] as const;

const REQUIRED_BILLING_ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID",
] as const;

const OPTIONAL_BILLING_ENV_KEYS = [
  "BILLING_SUCCESS_URL",
  "BILLING_CANCEL_URL",
  "BILLING_RETURN_URL",
] as const;

const AUTH_SERVER_ENV_KEYS = [
  "MCP_AUTHORIZATION_SERVER",
  "MCP_AUTHORIZATION_SERVER_URL",
  "WORKOS_AUTHKIT_ISSUER",
  "WORKOS_AUTHKIT_DOMAIN",
] as const;

const EXECUTOR_ROOT = path.resolve(import.meta.dir, "..", "..");

function addCheck(report: ProductionDoctorReport, name: string, ok: boolean, detail: string): void {
  report.checks.push({ name, ok, detail });
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

async function runConvex(args: string[]): Promise<CommandResult> {
  return await runCommand(["bunx", "convex", ...args]);
}

export function parseConvexEnvList(raw: string): Map<string, string> {
  const env = new Map<string, string>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1);
    if (key.length > 0) {
      env.set(key, value);
    }
  }

  return env;
}

function parseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function deploymentPrefix(hostname: string, suffix: ".convex.cloud" | ".convex.site"): string | null {
  if (!hostname.endsWith(suffix)) {
    return null;
  }
  return hostname.slice(0, hostname.length - suffix.length);
}

function addTokenStrengthCheck(report: ProductionDoctorReport, key: string, value: string): void {
  const looksUsable = value.length >= 24;
  addCheck(report, `${key} strength`, looksUsable, looksUsable ? "length looks reasonable" : "value seems too short");
}

export function buildEnvChecks(env: Map<string, string>): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const report: ProductionDoctorReport = { checks };

  for (const key of REQUIRED_PROD_ENV_KEYS) {
    const present = Boolean(env.get(key)?.trim());
    addCheck(report, `env:${key}`, present, present ? "set" : "missing");
  }

  for (const key of REQUIRED_APP_ENV_KEYS) {
    const present = Boolean(env.get(key)?.trim());
    addCheck(report, `env:${key}`, present, present ? "set" : "missing");
  }

  for (const key of REQUIRED_BILLING_ENV_KEYS) {
    const present = Boolean(env.get(key)?.trim());
    addCheck(
      report,
      `env:${key}`,
      present,
      present ? "set" : "missing (required while billing feature is enabled)",
    );
  }

  const authServerKey = AUTH_SERVER_ENV_KEYS.find((key) => Boolean(env.get(key)?.trim()));
  addCheck(
    report,
    "env:auth server",
    Boolean(authServerKey),
    authServerKey
      ? `using ${authServerKey}`
      : `missing (set one of ${AUTH_SERVER_ENV_KEYS.join(", ")})`,
  );

  const runUrlRaw = env.get("CLOUDFLARE_SANDBOX_RUN_URL")?.trim() ?? "";
  if (runUrlRaw) {
    const runUrl = parseUrl(runUrlRaw);
    if (!runUrl) {
      addCheck(report, "sandbox run URL format", false, `invalid URL: ${runUrlRaw}`);
    } else {
      addCheck(report, "sandbox run URL format", true, runUrlRaw);
      addCheck(
        report,
        "sandbox run URL protocol",
        runUrl.protocol === "https:",
        runUrl.protocol === "https:" ? "https" : `expected https, got ${runUrl.protocol}`,
      );
      addCheck(
        report,
        "sandbox run URL path",
        runUrl.pathname === "/v1/runs",
        runUrl.pathname === "/v1/runs" ? "path is /v1/runs" : `expected /v1/runs, got ${runUrl.pathname}`,
      );
    }
  }

  const convexUrlRaw = env.get("CONVEX_URL")?.trim() ?? "";
  if (convexUrlRaw) {
    const convexUrl = parseUrl(convexUrlRaw);
    if (!convexUrl) {
      addCheck(report, "convex URL format", false, `invalid URL: ${convexUrlRaw}`);
    } else {
      addCheck(report, "convex URL format", true, convexUrlRaw);
      addCheck(
        report,
        "convex URL protocol",
        convexUrl.protocol === "https:",
        convexUrl.protocol === "https:" ? "https" : `expected https, got ${convexUrl.protocol}`,
      );

      if (convexUrl.hostname.endsWith(".convex.site")) {
        addCheck(report, "convex URL host type", false, "uses .convex.site; expected API host (.convex.cloud)");
      } else if (convexUrl.hostname.endsWith(".convex.cloud")) {
        addCheck(report, "convex URL host type", true, "uses .convex.cloud API host");
      } else {
        addCheck(report, "convex URL host type", true, `custom host: ${convexUrl.hostname}`);
      }
    }
  }

  const convexSiteUrlRaw = env.get("CONVEX_SITE_URL")?.trim() ?? "";
  if (convexSiteUrlRaw) {
    const convexSiteUrl = parseUrl(convexSiteUrlRaw);
    addCheck(
      report,
      "convex site URL format",
      Boolean(convexSiteUrl),
      convexSiteUrl ? convexSiteUrlRaw : `invalid URL: ${convexSiteUrlRaw}`,
    );

    if (convexSiteUrl) {
      addCheck(
        report,
        "convex site URL protocol",
        convexSiteUrl.protocol === "https:",
        convexSiteUrl.protocol === "https:" ? "https" : `expected https, got ${convexSiteUrl.protocol}`,
      );
    }
  }

  if (convexUrlRaw && convexSiteUrlRaw) {
    const convexUrl = parseUrl(convexUrlRaw);
    const convexSiteUrl = parseUrl(convexSiteUrlRaw);
    if (convexUrl && convexSiteUrl) {
      const cloudPrefix = deploymentPrefix(convexUrl.hostname, ".convex.cloud");
      const sitePrefix = deploymentPrefix(convexSiteUrl.hostname, ".convex.site");
      if (cloudPrefix && sitePrefix) {
        addCheck(
          report,
          "convex deployment pairing",
          cloudPrefix === sitePrefix,
          cloudPrefix === sitePrefix
            ? `deployment ${cloudPrefix} matches`
            : `CONVEX_URL(${cloudPrefix}) does not match CONVEX_SITE_URL(${sitePrefix})`,
        );
      }
    }
  }

  const sandboxAuthToken = env.get("CLOUDFLARE_SANDBOX_AUTH_TOKEN")?.trim();
  if (sandboxAuthToken) {
    addTokenStrengthCheck(report, "CLOUDFLARE_SANDBOX_AUTH_TOKEN", sandboxAuthToken);
  }

  const internalSecret = env.get("EXECUTOR_INTERNAL_TOKEN")?.trim();
  if (internalSecret) {
    addTokenStrengthCheck(report, "EXECUTOR_INTERNAL_TOKEN", internalSecret);
  }

  const cloudflareOnlyMode = env.get("EXECUTOR_CLOUDFLARE_DYNAMIC_WORKER_ONLY")?.trim();
  if (cloudflareOnlyMode) {
    const enabled = isTruthy(cloudflareOnlyMode);
    addCheck(
      report,
      "runtime restriction mode",
      enabled,
      enabled
        ? "Cloudflare dynamic worker runtime-only mode is enabled"
        : `expected truthy value, got '${cloudflareOnlyMode}'`,
    );
  }

  for (const key of OPTIONAL_BILLING_ENV_KEYS) {
    const value = env.get(key)?.trim();
    addCheck(
      report,
      `env(optional):${key}`,
      true,
      value ? "set" : "not set (billing flow falls back to localhost URL)",
    );
  }

  return checks;
}

function guidanceForFailure(checkName: string): string[] {
  if (
    checkName === "env:CLOUDFLARE_SANDBOX_RUN_URL"
    || checkName === "env:CLOUDFLARE_SANDBOX_AUTH_TOKEN"
    || checkName === "env:EXECUTOR_INTERNAL_TOKEN"
    || checkName === "env:EXECUTOR_CLOUDFLARE_DYNAMIC_WORKER_ONLY"
  ) {
    return [
      "Run `bun run setup:prod:cloudflare --deploy` (or `bun run setup:prod:all`) to deploy sandbox host and set required Cloudflare runtime env vars.",
    ];
  }

  if (checkName === "runtime restriction mode") {
    return [
      "Set `EXECUTOR_CLOUDFLARE_DYNAMIC_WORKER_ONLY=1` in Convex prod env to force Cloudflare dynamic worker runtime.",
    ];
  }

  if (checkName === "env:CONVEX_URL") {
    return [
      "Set Convex API URL: `bunx convex env set CONVEX_URL https://<deployment>.convex.cloud --prod`.",
    ];
  }

  if (checkName === "convex URL host type") {
    return [
      "Use `.convex.cloud` for `CONVEX_URL` (do not use `.convex.site` for callback RPC).",
    ];
  }

  if (checkName === "env:WORKOS_CLIENT_ID" || checkName === "env:WORKOS_API_KEY" || checkName === "env:WORKOS_WEBHOOK_SECRET") {
    return [
      "Set WorkOS auth env vars with `bun run setup:prod:env --from-env` (after exporting WORKOS_* vars), or run `bun run setup:prod:all`.",
    ];
  }

  if (checkName === "env:WORKOS_COOKIE_PASSWORD") {
    return [
      "Set a strong cookie password (`WORKOS_COOKIE_PASSWORD`) via `bunx convex env set WORKOS_COOKIE_PASSWORD <VALUE> --prod`.",
    ];
  }

  if (checkName === "env:auth server") {
    return [
      "Set one auth server env var: `MCP_AUTHORIZATION_SERVER` (preferred) via `bunx convex env set MCP_AUTHORIZATION_SERVER <URL> --prod`.",
    ];
  }

  if (
    checkName === "env:STRIPE_SECRET_KEY"
    || checkName === "env:STRIPE_WEBHOOK_SECRET"
    || checkName === "env:STRIPE_PRICE_ID"
  ) {
    return [
      "Set Stripe billing env vars with `bun run setup:prod:env --from-env` (after exporting STRIPE_* vars), or run `bun run setup:prod:all`.",
    ];
  }

  return ["Inspect current prod vars with `bunx convex env list --prod`."];
}

export async function runProductionDoctor(): Promise<ProductionDoctorReport> {
  const report: ProductionDoctorReport = { checks: [] };

  const envResult = await runConvex(["env", "list", "--prod"]);
  if (envResult.exitCode !== 0) {
    const detail = (envResult.stderr.trim() || envResult.stdout.trim() || "unknown failure").split("\n")[0] ?? "unknown failure";
    addCheck(report, "convex env access", false, detail);
    return report;
  }

  addCheck(report, "convex env access", true, "able to read production Convex env");
  const env = parseConvexEnvList(envResult.stdout);

  report.checks.push(...buildEnvChecks(env));

  return report;
}

export function hasDoctorFailures(report: ProductionDoctorReport): boolean {
  return report.checks.some((check) => !check.ok);
}

async function main(): Promise<void> {
  const report = await runProductionDoctor();
  console.log("Production doctor");
  for (const check of report.checks) {
    const status = check.ok ? "ok" : "fail";
    console.log(`  [${status}] ${check.name}: ${check.detail}`);
  }

  const failedChecks = report.checks.filter((check) => !check.ok);
  if (failedChecks.length > 0) {
    const guidance = new Set<string>();
    for (const check of failedChecks) {
      for (const line of guidanceForFailure(check.name)) {
        guidance.add(line);
      }
    }

    console.log("\nHow to fix");
    for (const line of guidance) {
      console.log(`  - ${line}`);
    }
  }

  if (hasDoctorFailures(report)) {
    process.exit(1);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`doctor:prod failed: ${message}`);
    process.exit(1);
  }
}

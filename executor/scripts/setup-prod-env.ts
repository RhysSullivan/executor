interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Options {
  fromEnv: boolean;
  strict: boolean;
}

const REQUIRED_KEYS = [
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "WORKOS_WEBHOOK_SECRET",
  "WORKOS_COOKIE_PASSWORD",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID",
  "MCP_AUTHORIZATION_SERVER",
] as const;

const OPTIONAL_KEYS = [
  "BILLING_SUCCESS_URL",
  "BILLING_CANCEL_URL",
  "BILLING_RETURN_URL",
] as const;

function printHelp(): void {
  console.log(`Setup production Convex app env vars

Usage:
  bun run scripts/setup-prod-env.ts --from-env [--strict]

Options:
  --from-env   Read values from current shell env and push to Convex prod
  --strict     Fail if any required key is missing locally
  -h, --help   Show this help

Required local env keys:
  ${REQUIRED_KEYS.join("\n  ")}

Optional local env keys:
  ${OPTIONAL_KEYS.join("\n  ")}
`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    fromEnv: false,
    strict: false,
  };

  for (const arg of argv) {
    if (arg === "--from-env") {
      options.fromEnv = true;
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.fromEnv) {
    throw new Error("Use --from-env to read values from your local environment.");
  }

  return options;
}

async function runCommand(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
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

async function setConvexEnv(key: string, value: string): Promise<void> {
  const result = await runCommand(["bunx", "convex", "env", "set", key, value, "--prod"]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed setting ${key}: ${result.stderr || result.stdout}`);
  }
}

function redact(value: string): string {
  if (value.length < 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const missingRequired: string[] = [];
  const toSet: Array<{ key: string; value: string; optional: boolean }> = [];

  for (const key of REQUIRED_KEYS) {
    const value = Bun.env[key]?.trim();
    if (!value) {
      missingRequired.push(key);
      continue;
    }
    toSet.push({ key, value, optional: false });
  }

  for (const key of OPTIONAL_KEYS) {
    const value = Bun.env[key]?.trim();
    if (!value) {
      continue;
    }
    toSet.push({ key, value, optional: true });
  }

  if (missingRequired.length > 0) {
    console.log("[setup] missing required local env vars:");
    for (const key of missingRequired) {
      console.log(`  - ${key}`);
    }
    if (options.strict) {
      throw new Error("Required local env vars are missing and --strict was set.");
    }
    console.log("[setup] continuing with available values (use --strict to enforce all required vars)");
  }

  if (toSet.length === 0) {
    throw new Error("No env vars found to set. Export values and rerun with --from-env.");
  }

  console.log("[setup] pushing env vars to Convex prod...");
  for (const item of toSet) {
    await setConvexEnv(item.key, item.value);
    console.log(`  - ${item.key}=${redact(item.value)}${item.optional ? " (optional)" : ""}`);
  }

  console.log("[setup] done.");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[setup] failed: ${message}`);
  process.exit(1);
}

export {};

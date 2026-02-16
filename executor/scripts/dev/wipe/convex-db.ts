import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const executorDir = resolve(import.meta.dir, "../../..");
const schemaPath = resolve(executorDir, "packages/database/convex/schema.ts");
const emptyDataPath = join(tmpdir(), "convex-empty-array.json");
const fullVerify = Bun.env.CONVEX_WIPE_VERIFY_ALL === "1";
const skipVerify = Bun.env.CONVEX_WIPE_SKIP_VERIFY === "1";
const verifyRetries = Number.parseInt(Bun.env.CONVEX_WIPE_VERIFY_RETRIES ?? "20", 10);
const verifyDelayMs = Number.parseInt(Bun.env.CONVEX_WIPE_VERIFY_DELAY_MS ?? "500", 10);

function discoverTables(schemaSource: string): string[] {
  const matches = [...schemaSource.matchAll(/^\s*([A-Za-z0-9_]+):\s*defineTable\(/gm)];
  const tables = matches.map((match) => match[1]).filter((name): name is string => Boolean(name));
  if (tables.length === 0) {
    throw new Error("No Convex tables were discovered from schema.ts");
  }
  return tables;
}

async function runConvex(args: string[], options?: { captureOutput?: boolean }): Promise<string> {
  const child = Bun.spawn(["bunx", "convex", ...args], {
    cwd: executorDir,
    stdin: "inherit",
    stdout: options?.captureOutput ? "pipe" : "inherit",
    stderr: "inherit",
    env: process.env,
  });

  const output = options?.captureOutput
    ? await new Response(child.stdout).text()
    : "";

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`convex ${args.join(" ")} failed with exit code ${exitCode}`);
  }

  return output;
}

async function assertTableEmpty(table: string): Promise<void> {
  const maxAttempts = Number.isFinite(verifyRetries) && verifyRetries > 0 ? verifyRetries : 20;
  const delayMs = Number.isFinite(verifyDelayMs) && verifyDelayMs >= 0 ? verifyDelayMs : 500;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const output = await runConvex(["data", table, "--limit", "1", "--format", "jsonLines"], {
      captureOutput: true,
    });

    const trimmed = output.trim();
    if (trimmed.length === 0 || trimmed.includes("There are no documents in this table")) {
      return;
    }

    if (attempt < maxAttempts) {
      await Bun.sleep(delayMs);
      continue;
    }

    const preview = trimmed.split("\n").slice(0, 3).join("\n");
    throw new Error(`Table '${table}' still has documents after wipe. Sample output:\n${preview}`);
  }
}

const schemaSource = await Bun.file(schemaPath).text();
const tables = discoverTables(schemaSource);
const anchorTable = tables[0];
if (!anchorTable) {
  throw new Error("No Convex tables were discovered from schema.ts");
}

await Bun.write(emptyDataPath, "[]\n");

console.log(`Wiping ${tables.length} table(s) from deployment using a single replace-all import...`);
await runConvex([
  "import",
  "--table",
  anchorTable,
  "--replace-all",
  "--yes",
  "--format",
  "jsonArray",
  emptyDataPath,
]);

if (!skipVerify) {
  const verifyTables = fullVerify
    ? tables
    : tables.filter((table) => table === "workspaces" || table === "organizations" || table === "accounts");

  const sampledVerifyTables = verifyTables.length > 0
    ? verifyTables
    : tables.slice(0, Math.min(3, tables.length));

  console.log(`\nVerifying ${sampledVerifyTables.length} table(s) are empty${fullVerify ? " (full verify)" : " (quick verify)"}...`);
  for (const table of sampledVerifyTables) {
    await assertTableEmpty(table);
  }
} else {
  console.log("\nSkipping verification (CONVEX_WIPE_SKIP_VERIFY=1).");
}

console.log("\nDatabase wipe complete.");

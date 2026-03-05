import { validateEnv } from "better-env/validate-env";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceDirs = [
  "apps/web",
  "apps/cli",
  "packages/persistence-sql",
] as const;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const environment = process.argv[2] ?? "development";

let hasErrors = false;

for (const workspaceDir of workspaceDirs) {
  const projectDir = path.resolve(repoRoot, workspaceDir);
  console.log(`\n=== ${workspaceDir} ===`);

  const { exitCode } = await validateEnv({
    environment,
    projectDir,
  });

  if (exitCode !== 0) {
    hasErrors = true;
  }
}

if (hasErrors) {
  process.exit(1);
}

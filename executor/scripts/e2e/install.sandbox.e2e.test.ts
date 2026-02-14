import { expect, test } from "bun:test";
import { Sandbox } from "@vercel/sandbox";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runSandboxBash(
  sandbox: Sandbox,
  script: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const command = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", script],
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

test("installer works in fresh Vercel sandbox", async () => {
  const credentials =
    process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
      ? {
          token: process.env.VERCEL_TOKEN,
          teamId: process.env.VERCEL_TEAM_ID,
          projectId: process.env.VERCEL_PROJECT_ID,
        }
      : {};

  let sandbox: Sandbox | null = null;

  try {
    sandbox = await Sandbox.create({
      runtime: "node22",
      timeout: 30 * 60 * 1000,
      ...credentials,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not create Vercel sandbox. Configure auth via VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID or VERCEL_OIDC_TOKEN.\n\n${message}`,
    );
  }

  try {
    const install = await runSandboxBash(
      sandbox,
      [
        "set -euo pipefail",
        "cd ~",
        "if [ -x ~/.executor/bin/executor ]; then ~/.executor/bin/executor uninstall --yes || true; fi",
        "rm -rf ~/.executor",
        "start=$(date +%s)",
        "curl -fsSL https://executor.sh/install | bash",
        "end=$(date +%s)",
        "echo INSTALL_SECONDS=$((end-start))",
        "~/.executor/bin/executor doctor --verbose",
      ].join("; "),
      900_000,
    );
    assertSuccess(install, "sandbox install + doctor");

    const output = `${install.stdout}\n${install.stderr}`;
    expect(output).toContain("Executor status: ready");
    expect(output).toContain("Functions: bootstrapped");

    const uninstall = await runSandboxBash(
      sandbox,
      [
        "set -euo pipefail",
        "~/.executor/bin/executor uninstall --yes",
        "test ! -e ~/.executor/runtime/convex-data/convex_local_backend.sqlite3",
      ].join("; "),
      300_000,
    );
    assertSuccess(uninstall, "sandbox uninstall validation");
  } finally {
    await sandbox.stop();
  }
}, 1_200_000);

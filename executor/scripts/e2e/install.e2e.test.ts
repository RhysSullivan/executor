import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

function repositoryRoot(): string {
  return path.resolve(import.meta.dir, "..", "..");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  const startedAt = Date.now();
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = options.timeoutMs ?? 120_000;
  const timeout = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
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

test("installer e2e: uninstall, install, deploy, and cleanup", async () => {
  const repoRoot = repositoryRoot();
  const installScript = path.join(repoRoot, "install");
  const binaryPath = path.join(repoRoot, "dist", "executor");

  if (!(await pathExists(binaryPath))) {
    const buildBinary = await runCommand(["bun", "run", "build:binary"], {
      cwd: repoRoot,
      env: process.env,
      timeoutMs: 240_000,
    });
    assertSuccess(buildBinary, "build binary");
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "executor-install-e2e-"));
  const installCwd = path.join(tempRoot, "workdir");
  const bootstrapArchive = path.join(tempRoot, "bootstrap-project.tar.gz");
  const homeDir = path.join(tempRoot, "home");
  const executorHome = path.join(homeDir, ".executor");
  const installDir = path.join(executorHome, "bin");
  const runtimeDir = path.join(executorHome, "runtime");
  const webDir = path.join(runtimeDir, "web");
  const installedBinary = path.join(installDir, "executor");

  const basePort = 45000 + Math.floor(Math.random() * 1000) * 3;
  const backendPort = String(basePort);
  const sitePort = String(basePort + 1);
  const webPort = String(basePort + 2);

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: homeDir,
    EXECUTOR_HOME_DIR: executorHome,
    EXECUTOR_INSTALL_DIR: installDir,
    EXECUTOR_RUNTIME_DIR: runtimeDir,
    EXECUTOR_WEB_INSTALL_DIR: webDir,
    EXECUTOR_BACKEND_PORT: backendPort,
    EXECUTOR_BACKEND_SITE_PORT: sitePort,
    EXECUTOR_WEB_PORT: webPort,
    EXECUTOR_BOOTSTRAP_PROJECT_ARCHIVE: bootstrapArchive,
  };

  try {
    await fs.mkdir(installCwd, { recursive: true });

    const archiveSource = await runCommand([
      "tar",
      "--exclude=.git",
      "--exclude=node_modules",
      "--exclude=dist",
      "--exclude=.next",
      "--exclude=.turbo",
      "-czf",
      bootstrapArchive,
      "-C",
      path.dirname(repoRoot),
      path.basename(repoRoot),
    ], {
      cwd: repoRoot,
      env,
      timeoutMs: 300_000,
    });
    assertSuccess(archiveSource, "create bootstrap project archive");

    const preUninstall = await runCommand(["bash", path.join(repoRoot, "uninstall"), "--yes"], {
      cwd: repoRoot,
      env,
    });
    assertSuccess(preUninstall, "pre-uninstall");

    expect(await pathExists(installedBinary)).toBe(false);
    expect(await pathExists(runtimeDir)).toBe(false);

    const install = await runCommand([
      "bash",
      installScript,
      "--binary",
      binaryPath,
      "--no-modify-path",
      "--no-star-prompt",
    ], {
      cwd: installCwd,
      env,
      timeoutMs: 420_000,
    });
    assertSuccess(install, "install");

    expect(await pathExists(installedBinary)).toBe(true);
    expect(await pathExists(path.join(webDir, "server.js"))).toBe(true);

    const doctor = await runCommand([installedBinary, "doctor", "--verbose"], {
      cwd: repoRoot,
      env,
      timeoutMs: 180_000,
    });
    assertSuccess(doctor, "doctor");

    expect(doctor.stdout).toContain("Executor status: ready");
    expect(doctor.stdout).toContain("Backend: running");
    expect(doctor.stdout).toContain(`Dashboard: http://127.0.0.1:${webPort} (running)`);
    expect(doctor.stdout).toContain("Functions: bootstrapped");

    const uninstall = await runCommand([installedBinary, "uninstall", "--yes"], {
      cwd: repoRoot,
      env,
      timeoutMs: 120_000,
    });
    assertSuccess(uninstall, "uninstall");

    expect(await pathExists(installedBinary)).toBe(false);
    expect(await pathExists(runtimeDir)).toBe(false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}, 600_000);

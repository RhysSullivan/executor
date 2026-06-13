/**
 * Desktop-side manager for the OS-supervised Executor daemon (macOS launchd).
 *
 * The desktop drives launchd directly — it writes a LaunchAgent that runs the
 * bundled `executor-sidecar` binary in supervised mode (EXECUTOR_SUPERVISED=1),
 * so the daemon outlives the app and restarts on login. The app is then a thin
 * client that attaches to it (see sidecar.ts `attachToSupervisedDaemon`). We do
 * NOT use SMAppService: its plist must be code-signed into the bundle, whereas
 * this dynamic plist points at the bundle's absolute sidecar path. The unit
 * carries no secret — the daemon mints/loads its bearer from auth.json.
 *
 * The plist skeleton mirrors apps/cli/src/service.ts `generateLaunchdPlist`
 * (the CLI is the canonical copy); keep the two in sync if the format changes.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import log from "electron-log/main.js";

const serviceLog = log.scope("service");
const execFileAsync = promisify(execFile);

export const SERVICE_LABEL = "sh.executor.daemon";

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: string, args: string[]): Promise<CommandResult> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: capture exit code rather than throw on non-zero
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string };
    if (typeof err.code === "string") {
      // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: command could not be spawned
      throw new Error(`Failed to run \`${cmd}\`: ${err.code}`);
    }
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
};

const currentUid = (): number => {
  const getuid = (process as { getuid?: () => number }).getuid;
  return typeof getuid === "function" ? getuid.call(process) : userInfo().uid;
};

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const launchAgentsDir = (): string => join(homedir(), "Library", "LaunchAgents");
const plistPath = (): string => join(launchAgentsDir(), `${SERVICE_LABEL}.plist`);
const serviceTarget = (uid: number): string => `gui/${uid}/${SERVICE_LABEL}`;

const sidecarBinaryPath = (): string => {
  const name = process.platform === "win32" ? "executor-sidecar.exe" : "executor-sidecar";
  return join(process.resourcesPath, "sidecar", name);
};

const webUiDir = (): string => join(process.resourcesPath, "web-ui");

interface PlistOptions {
  readonly label: string;
  readonly programArguments: ReadonlyArray<string>;
  readonly environment: Record<string, string>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly workingDirectory: string;
}

const generateLaunchdPlist = (options: PlistOptions): string => {
  const programArgs = options.programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(options.environment)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(options.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(options.stderrPath)}</string>
</dict>
</plist>
`;
};

/**
 * Capture the user's login-shell PATH. A launchd daemon starts with a bare
 * PATH; without the user's PATH the daemon can't find pyenv/nvm/Homebrew tools
 * that integrations may shell out to. Falls back to the app's own PATH.
 * (Reference: opencode's shell-env capture.)
 */
const captureUserPath = async (): Promise<string | undefined> => {
  const shell = process.env.SHELL;
  if (!shell) return process.env.PATH;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a slow/odd login shell must not break install
  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", 'printf "%s" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
    });
    const path = stdout.trim();
    return path.length > 0 ? path : process.env.PATH;
  } catch {
    return process.env.PATH;
  }
};

export interface SupervisedServiceStatus {
  readonly supported: boolean;
  readonly registered: boolean;
  readonly running: boolean;
}

const isSupported = (): boolean => app.isPackaged && process.platform === "darwin";

export const supervisedServiceStatus = async (): Promise<SupervisedServiceStatus> => {
  if (!isSupported()) return { supported: false, registered: false, running: false };
  const registered = existsSync(plistPath());
  const print = await runCommand("launchctl", ["print", serviceTarget(currentUid())]);
  return { supported: true, registered, running: print.code === 0 };
};

export interface InstallOptions {
  readonly port: number;
  readonly dataDir: string;
}

/**
 * Register + start the supervised daemon (the bundled sidecar under launchd).
 * The unit carries no secret — the daemon mints/loads its bearer from auth.json
 * under EXECUTOR_DATA_DIR, and desktop/CLI clients read the same file.
 */
export const installSupervisedService = async (opts: InstallOptions): Promise<void> => {
  const uid = currentUid();
  const logs = join(opts.dataDir, "logs");
  mkdirSync(launchAgentsDir(), { recursive: true });
  mkdirSync(logs, { recursive: true });

  const userPath = await captureUserPath();
  const environment: Record<string, string> = {
    EXECUTOR_SUPERVISED: "1",
    EXECUTOR_PORT: String(opts.port),
    EXECUTOR_HOST: "127.0.0.1",
    EXECUTOR_DATA_DIR: opts.dataDir,
    EXECUTOR_SCOPE_DIR: opts.dataDir,
    EXECUTOR_CLIENT_DIR: webUiDir(),
    EXECUTOR_CLIENT: "desktop",
    EXECUTOR_SERVICE_VERSION: app.getVersion() || "",
    ...(userPath ? { PATH: userPath } : {}),
  };

  const plist = generateLaunchdPlist({
    label: SERVICE_LABEL,
    programArguments: [sidecarBinaryPath()],
    environment,
    stdoutPath: join(logs, "daemon.log"),
    stderrPath: join(logs, "daemon.error.log"),
    workingDirectory: opts.dataDir,
  });
  writeFileSync(plistPath(), plist, { mode: 0o600 });

  // Re-bootstrap cleanly so a stale registration doesn't make bootstrap fail.
  await runCommand("launchctl", ["bootout", serviceTarget(uid)]);
  const bootstrap = await runCommand("launchctl", ["bootstrap", `gui/${uid}`, plistPath()]);
  if (bootstrap.code !== 0) {
    // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: surfaces to the boot flow
    throw new Error(
      `launchctl bootstrap failed (exit ${bootstrap.code}): ${bootstrap.stderr.trim() || bootstrap.stdout.trim()}`,
    );
  }
  await runCommand("launchctl", ["enable", serviceTarget(uid)]);
  serviceLog.info(`installed supervised service on port ${opts.port}`);
};

export const uninstallSupervisedService = async (dataDir: string): Promise<void> => {
  const uid = currentUid();
  await runCommand("launchctl", ["bootout", serviceTarget(uid)]);
  await runCommand("launchctl", ["disable", serviceTarget(uid)]);
  rmSync(plistPath(), { force: true });
  // Clean up a legacy service.key from a pre-bearer install (best-effort).
  rmSync(join(dataDir, "server-control", "service.key"), { force: true });
  serviceLog.info("uninstalled supervised service");
};

/** Restart the supervised daemon atomically (kill + relaunch via launchd). */
export const restartSupervisedService = async (): Promise<void> => {
  await runCommand("launchctl", ["kickstart", "-k", serviceTarget(currentUid())]);
};

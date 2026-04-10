import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";

const execFileAsync = promisify(execFile);

export interface LaunchctlResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

interface ExecFileError {
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

export const launchctl = (args: readonly string[]): Effect.Effect<LaunchctlResult, never> =>
  Effect.promise(async () => {
    try {
      const { stdout, stderr } = await execFileAsync("launchctl", [...args]);
      return {
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        code: 0,
      };
    } catch (raw) {
      const err = raw as ExecFileError;
      return {
        stdout: err.stdout === undefined ? "" : String(err.stdout),
        stderr:
          err.stderr === undefined
            ? err.message === undefined
              ? ""
              : String(err.message)
            : String(err.stderr),
        code: typeof err.code === "number" ? err.code : 1,
      };
    }
  });

export const getGuiDomain = (): string =>
  `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;

export const parseLaunchdPid = (printOutput: string): number | undefined => {
  const match = printOutput.match(/\bpid\s*=\s*(\d+)\b/);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_EXECUTOR_LAUNCHD_LABEL = "sh.executor.daemon";

export interface LaunchdServiceSpec {
  readonly label: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export const getDefaultLaunchAgentPath = (label: string): string =>
  join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

export const getDefaultExecutorLogPath = (): string => join(homedir(), ".executor", "daemon.log");

export const buildExecutorLaunchdPath = (currentPath?: string): string => {
  const preferred = [
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".local", "bin"),
    join(homedir(), "bin"),
    join(homedir(), ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const extras = (currentPath ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const seen = new Set<string>();
  return [...preferred, ...extras]
    .filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    })
    .join(":");
};

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export const renderLaunchAgentPlist = (spec: LaunchdServiceSpec): string => {
  const programArgs = [spec.program, ...spec.args]
    .map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`)
    .join("\n");

  const envEntries = Object.entries(spec.environment ?? {})
    .filter(([, value]) => value.length > 0)
    .map(
      ([key, value]) =>
        `\t\t<key>${xmlEscape(key)}</key>\n\t\t<string>${xmlEscape(value)}</string>`,
    )
    .join("\n");

  const envBlock =
    envEntries.length > 0
      ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${envEntries}\n\t</dict>\n`
      : "";

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n` +
    `<dict>\n` +
    `\t<key>Label</key>\n\t<string>${xmlEscape(spec.label)}</string>\n` +
    `\t<key>ProgramArguments</key>\n\t<array>\n${programArgs}\n\t</array>\n` +
    `\t<key>RunAtLoad</key>\n\t<true/>\n` +
    `\t<key>KeepAlive</key>\n\t<true/>\n` +
    envBlock +
    `\t<key>StandardOutPath</key>\n\t<string>${xmlEscape(spec.stdoutPath)}</string>\n` +
    `\t<key>StandardErrorPath</key>\n\t<string>${xmlEscape(spec.stderrPath)}</string>\n` +
    `</dict>\n` +
    `</plist>\n`
  );
};

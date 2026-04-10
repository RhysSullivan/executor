import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import { gracefulStopPid, isPidAlive, isReachable, pollReadiness } from "@executor/supervisor";

import {
  DEFAULT_EXECUTOR_LAUNCHD_LABEL,
  buildExecutorLaunchdPath,
  getDefaultExecutorLogPath,
  getDefaultLaunchAgentPath,
  renderLaunchAgentPlist,
  type LaunchdServiceSpec,
} from "./plist.js";
import { getGuiDomain, launchctl, parseLaunchdPid } from "./launchctl.js";
import {
  LaunchdBootoutFailed,
  LaunchdBootstrapFailed,
  LaunchdReadinessTimeout,
  LaunchdUnsupportedPlatform,
} from "./errors.js";

export interface InstallOptions {
  readonly label?: string;
  readonly plistPath?: string;
  readonly logPath?: string;
  readonly port?: number;
  readonly scope?: string;
  readonly readinessUrl?: string;
  readonly readinessTimeoutMs?: number;
  readonly programArgs?: readonly string[];
}

export interface InstallResult {
  readonly label: string;
  readonly plistPath: string;
  readonly logPath: string;
  readonly url: string;
}

export interface AgentStatus {
  readonly label: string;
  readonly plistPath: string;
  readonly logPath: string;
  readonly installed: boolean;
  readonly running: boolean;
  readonly pid?: number;
  readonly reachable: boolean;
  readonly url: string;
}

export type LaunchdError =
  | LaunchdUnsupportedPlatform
  | LaunchdBootstrapFailed
  | LaunchdReadinessTimeout
  | LaunchdBootoutFailed;

const DEFAULT_PORT = 4788;

const requireDarwin = (): Effect.Effect<void, LaunchdUnsupportedPlatform> =>
  process.platform === "darwin"
    ? Effect.void
    : Effect.fail(
        new LaunchdUnsupportedPlatform({
          platform: process.platform,
          message: `macOS launchd is only supported on darwin (got ${process.platform})`,
        }),
      );

const expandHome = (path: string): string => {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
};

const resolveConfig = (opts: InstallOptions = {}) => {
  const label = opts.label ?? DEFAULT_EXECUTOR_LAUNCHD_LABEL;
  const plistPath = opts.plistPath ? expandHome(opts.plistPath) : getDefaultLaunchAgentPath(label);
  const logPath = opts.logPath ? expandHome(opts.logPath) : getDefaultExecutorLogPath();
  const port = opts.port ?? DEFAULT_PORT;
  const url = opts.readinessUrl ?? `http://127.0.0.1:${port}/api/scope`;
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 10_000;
  return {
    label,
    plistPath,
    logPath,
    port,
    url,
    readinessTimeoutMs,
    scope: opts.scope,
  };
};

const resolveCliEntry = (): readonly string[] => {
  const script = process.argv[1];
  if (!script || resolve(script) === resolve(process.execPath)) return [];
  return [resolve(script)];
};

const buildProgramArgs = (
  port: number,
  scope: string | undefined,
  override: readonly string[] | undefined,
): readonly string[] => {
  if (override) return override;
  return [
    ...resolveCliEntry(),
    "web",
    "--port",
    String(port),
    ...(scope ? ["--scope", scope] : []),
  ];
};

const makeBootstrapFailed = (
  label: string,
  plistPath: string,
  result: { readonly stdout: string; readonly stderr: string; readonly code: number },
) =>
  new LaunchdBootstrapFailed({
    label,
    plistPath,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  });

export const installAgent = (
  opts: InstallOptions = {},
): Effect.Effect<InstallResult, LaunchdError> =>
  Effect.gen(function* () {
    yield* requireDarwin();
    const cfg = resolveConfig(opts);
    const domain = getGuiDomain();
    const target = `${domain}/${cfg.label}`;

    yield* Effect.promise(async () => {
      await mkdir(dirname(cfg.plistPath), { recursive: true });
      await mkdir(dirname(cfg.logPath), { recursive: true });
    }).pipe(Effect.orDie);

    const spec: LaunchdServiceSpec = {
      label: cfg.label,
      program: process.execPath,
      args: buildProgramArgs(cfg.port, cfg.scope, opts.programArgs),
      stdoutPath: cfg.logPath,
      stderrPath: cfg.logPath,
      environment: { PATH: buildExecutorLaunchdPath(process.env.PATH) },
    };

    yield* Effect.promise(() =>
      writeFile(cfg.plistPath, renderLaunchAgentPlist(spec), "utf8"),
    ).pipe(Effect.orDie);

    yield* launchctl(["bootout", domain, cfg.plistPath]);
    const boot = yield* launchctl(["bootstrap", domain, cfg.plistPath]);
    if (boot.code !== 0) {
      return yield* makeBootstrapFailed(cfg.label, cfg.plistPath, boot);
    }

    const alreadyReachable = yield* isReachable(cfg.url, { probeTimeoutMs: 500 });
    if (!alreadyReachable) {
      yield* launchctl(["kickstart", "-k", target]);
    }

    yield* pollReadiness(cfg.url, {
      timeoutMs: cfg.readinessTimeoutMs,
      intervalMs: 100,
    }).pipe(
      Effect.catchTag("ReadinessTimeout", (err) =>
        Effect.gen(function* () {
          yield* launchctl(["bootout", domain, cfg.plistPath]);
          return yield* new LaunchdReadinessTimeout({
            label: cfg.label,
            url: err.url,
            elapsedMs: err.elapsedMs,
          });
        }),
      ),
    );

    return {
      label: cfg.label,
      plistPath: cfg.plistPath,
      logPath: cfg.logPath,
      url: cfg.url,
    };
  });

export const startAgent = (
  opts: Pick<
    InstallOptions,
    "label" | "plistPath" | "port" | "readinessUrl" | "readinessTimeoutMs"
  > = {},
): Effect.Effect<void, LaunchdError> =>
  Effect.gen(function* () {
    yield* requireDarwin();
    const cfg = resolveConfig(opts);
    const domain = getGuiDomain();
    const target = `${domain}/${cfg.label}`;

    yield* launchctl(["bootout", domain, cfg.plistPath]);
    const boot = yield* launchctl(["bootstrap", domain, cfg.plistPath]);
    if (boot.code !== 0) {
      return yield* makeBootstrapFailed(cfg.label, cfg.plistPath, boot);
    }

    yield* launchctl(["kickstart", "-k", target]);

    yield* pollReadiness(cfg.url, {
      timeoutMs: cfg.readinessTimeoutMs,
      intervalMs: 100,
    }).pipe(
      Effect.catchTag("ReadinessTimeout", (err) =>
        Effect.fail(
          new LaunchdReadinessTimeout({
            label: cfg.label,
            url: err.url,
            elapsedMs: err.elapsedMs,
          }),
        ),
      ),
    );
  });

export const stopAgent = (
  opts: Pick<InstallOptions, "label" | "plistPath"> = {},
): Effect.Effect<void, LaunchdError> =>
  Effect.gen(function* () {
    yield* requireDarwin();
    const cfg = resolveConfig(opts);
    const domain = getGuiDomain();
    const target = `${domain}/${cfg.label}`;

    const printRes = yield* launchctl(["print", target]);
    if (printRes.code === 0) {
      const pid = parseLaunchdPid(printRes.stdout);
      if (pid !== undefined && isPidAlive(pid)) {
        yield* gracefulStopPid(pid, {
          signals: ["SIGTERM", "SIGINT"],
          signalDelayMs: 500,
          killAfterMs: 5_000,
        });
      }
    }

    const bootout = yield* launchctl(["bootout", domain, cfg.plistPath]);
    if (printRes.code === 0 && bootout.code !== 0) {
      return yield* new LaunchdBootoutFailed({
        label: cfg.label,
        plistPath: cfg.plistPath,
        stdout: bootout.stdout,
        stderr: bootout.stderr,
        code: bootout.code,
      });
    }
  });

export const uninstallAgent = (
  opts: Pick<InstallOptions, "label" | "plistPath"> = {},
): Effect.Effect<void, LaunchdError> =>
  Effect.gen(function* () {
    yield* stopAgent(opts);
    const cfg = resolveConfig(opts);
    yield* Effect.promise(() => rm(cfg.plistPath, { force: true })).pipe(Effect.orDie);
  });

export const printAgent = (
  opts: Pick<InstallOptions, "label" | "plistPath" | "logPath" | "port" | "readinessUrl"> = {},
): Effect.Effect<AgentStatus, LaunchdUnsupportedPlatform> =>
  Effect.gen(function* () {
    yield* requireDarwin();
    const cfg = resolveConfig(opts);
    const target = `${getGuiDomain()}/${cfg.label}`;
    const printRes = yield* launchctl(["print", target]);
    const pid = printRes.code === 0 ? parseLaunchdPid(printRes.stdout) : undefined;
    const reachable = yield* isReachable(cfg.url, { probeTimeoutMs: 500 });

    return {
      label: cfg.label,
      plistPath: cfg.plistPath,
      logPath: cfg.logPath,
      installed: existsSync(cfg.plistPath),
      running: printRes.code === 0,
      pid,
      reachable,
      url: cfg.url,
    };
  });

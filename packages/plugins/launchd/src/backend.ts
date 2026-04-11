import { Effect, Layer } from "effect";
import {
  BootstrapFailed,
  PlatformSupervisor,
  ServiceReadinessTimeout,
  TeardownFailed,
  UnsupportedPlatform,
  type InstallResult as CoreInstallResult,
  type ServiceSpec,
  type ServiceStatus,
  type SupervisorError,
} from "@executor/supervisor";

import {
  installAgent,
  printAgent,
  startAgent,
  stopAgent,
  uninstallAgent,
  type AgentStatus,
  type InstallOptions,
  type InstallResult,
  type LaunchdError,
} from "./supervisor.js";
import type { LaunchdUnsupportedPlatform } from "./errors.js";

/**
 * Translate a platform-neutral {@link ServiceSpec} into the launchd-specific
 * {@link InstallOptions} shape consumed by the lifecycle Effects in
 * `supervisor.ts`. The only non-trivial mapping is `unitFilePath → plistPath`;
 * everything else is a direct rename or pass-through.
 */
const toInstallOptions = (spec: ServiceSpec): InstallOptions => ({
  label: spec.label,
  plistPath: spec.unitFilePath,
  logPath: spec.logPath,
  port: spec.port,
  scope: spec.scope,
  readinessUrl: spec.readinessUrl,
  readinessTimeoutMs: spec.readinessTimeoutMs,
  programArgs: spec.programArgs,
});

const toCoreInstallResult = (result: InstallResult): CoreInstallResult => ({
  label: result.label,
  unitFilePath: result.plistPath,
  logPath: result.logPath,
  url: result.url,
});

const toCoreStatus = (status: AgentStatus): ServiceStatus => ({
  label: status.label,
  unitFilePath: status.plistPath,
  logPath: status.logPath,
  url: status.url,
  installed: status.installed,
  running: status.running,
  pid: status.pid,
  reachable: status.reachable,
});

/**
 * Map the full {@link LaunchdError} union onto the core {@link SupervisorError}
 * union at the layer boundary. Used by install/start/stop/uninstall.
 */
const mapFullError = <A>(
  effect: Effect.Effect<A, LaunchdError>,
): Effect.Effect<A, SupervisorError> =>
  effect.pipe(
    Effect.catchTags({
      LaunchdUnsupportedPlatform: (err) =>
        Effect.fail(new UnsupportedPlatform({ platform: err.platform, message: err.message })),
      LaunchdBootstrapFailed: (err) =>
        Effect.fail(
          new BootstrapFailed({
            label: err.label,
            code: err.code,
            stdout: err.stdout,
            stderr: err.stderr,
          }),
        ),
      LaunchdBootoutFailed: (err) =>
        Effect.fail(
          new TeardownFailed({
            label: err.label,
            code: err.code,
            stdout: err.stdout,
            stderr: err.stderr,
          }),
        ),
      LaunchdReadinessTimeout: (err) =>
        Effect.fail(
          new ServiceReadinessTimeout({
            label: err.label,
            url: err.url,
            elapsedMs: err.elapsedMs,
          }),
        ),
    }),
  );

/**
 * Narrow mapper for `printAgent`, which only raises
 * {@link LaunchdUnsupportedPlatform}.
 */
const mapUnsupportedOnly = <A>(
  effect: Effect.Effect<A, LaunchdUnsupportedPlatform>,
): Effect.Effect<A, SupervisorError> =>
  effect.pipe(
    Effect.catchTag("LaunchdUnsupportedPlatform", (err) =>
      Effect.fail(new UnsupportedPlatform({ platform: err.platform, message: err.message })),
    ),
  );

/**
 * Build the macOS launchd {@link PlatformSupervisor} layer. Each method
 * delegates to the existing lifecycle Effects in `./supervisor.js` after
 * translating the platform-neutral {@link ServiceSpec} into the plugin's
 * internal `InstallOptions` shape.
 */
export const makeLaunchdSupervisorLayer = (): Layer.Layer<PlatformSupervisor> =>
  Layer.succeed(PlatformSupervisor, {
    install: (spec) =>
      mapFullError(installAgent(toInstallOptions(spec)).pipe(Effect.map(toCoreInstallResult))),
    uninstall: (spec) => mapFullError(uninstallAgent(toInstallOptions(spec))),
    start: (spec) => mapFullError(startAgent(toInstallOptions(spec))),
    stop: (spec) => mapFullError(stopAgent(toInstallOptions(spec))),
    status: (spec) =>
      mapUnsupportedOnly(printAgent(toInstallOptions(spec)).pipe(Effect.map(toCoreStatus))),
  });

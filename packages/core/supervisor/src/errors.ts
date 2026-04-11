import { Data } from "effect";

/**
 * Low-level readiness probe timeout raised by {@link pollReadiness}.
 *
 * This is a primitive error returned from the readiness utilities; it is NOT
 * part of the {@link SupervisorError} union returned by the high-level
 * {@link PlatformSupervisor} interface. Backends that use `pollReadiness`
 * internally catch this and re-raise as {@link ServiceReadinessTimeout}.
 */
export class ReadinessTimeout extends Data.TaggedError("ReadinessTimeout")<{
  readonly url: string;
  readonly elapsedMs: number;
  readonly attempts: number;
}> {}

/**
 * The current runtime platform has no registered {@link PlatformSupervisor}
 * backend. Raised by every method of the unsupported-platform layer and by
 * backends that were loaded on an incompatible OS.
 */
export class UnsupportedPlatform extends Data.TaggedError("UnsupportedPlatform")<{
  readonly platform: string;
  readonly message?: string;
}> {}

/**
 * A backend-level install, start, or reload operation failed because the
 * underlying service-manager command (e.g. `launchctl bootstrap`) exited
 * non-zero. The payload carries the captured stdio for CLI rendering.
 */
export class BootstrapFailed extends Data.TaggedError("BootstrapFailed")<{
  readonly label: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {}

/**
 * A backend-level stop or uninstall operation failed because the underlying
 * service-manager teardown command (e.g. `launchctl bootout`) exited non-zero.
 */
export class TeardownFailed extends Data.TaggedError("TeardownFailed")<{
  readonly label: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {}

/**
 * A backend install or start operation successfully bootstrapped the service,
 * but the HTTP readiness probe never succeeded before the deadline. Distinct
 * from the primitive {@link ReadinessTimeout} because it carries the service
 * label so the CLI can render a scoped error message.
 */
export class ServiceReadinessTimeout extends Data.TaggedError("ServiceReadinessTimeout")<{
  readonly label: string;
  readonly url: string;
  readonly elapsedMs: number;
}> {}

/**
 * Union of all errors that the high-level {@link PlatformSupervisor} interface
 * may raise. Each concrete backend is responsible for mapping its own internal
 * tagged errors onto this union at the layer boundary, so the CLI and tools
 * surface a single consistent error taxonomy regardless of the active OS.
 */
export type SupervisorError =
  | UnsupportedPlatform
  | BootstrapFailed
  | TeardownFailed
  | ServiceReadinessTimeout;

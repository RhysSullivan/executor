import { Context, Effect } from "effect";

import type { SupervisorError } from "./errors.js";
import type { InstallResult, ServiceSpec, ServiceStatus } from "./service-spec.js";

/**
 * The contract every platform-specific supervisor backend must satisfy.
 *
 * Backends live in their own packages (`@executor/plugin-launchd`, future
 * `@executor/plugin-systemd`) and expose a `Layer<PlatformSupervisor>` that
 * apps provide to Effect programs. The high-level `service` CLI commands and
 * the MCP runtime tool plugin both consume this interface via the
 * {@link PlatformSupervisor} Context tag, so neither has to know about
 * platform-specific primitives like plist files or systemctl.
 */
export interface PlatformSupervisorShape {
  readonly install: (spec: ServiceSpec) => Effect.Effect<InstallResult, SupervisorError>;
  readonly uninstall: (spec: ServiceSpec) => Effect.Effect<void, SupervisorError>;
  readonly start: (spec: ServiceSpec) => Effect.Effect<void, SupervisorError>;
  readonly stop: (spec: ServiceSpec) => Effect.Effect<void, SupervisorError>;
  readonly status: (spec: ServiceSpec) => Effect.Effect<ServiceStatus, SupervisorError>;
}

/**
 * Effect Context tag for the active platform supervisor. The class name and
 * the tag identity are the same symbol — this is the idiomatic Effect pattern
 * for exposing a service shape via Context.
 */
export class PlatformSupervisor extends Context.Tag("@executor/supervisor/PlatformSupervisor")<
  PlatformSupervisor,
  PlatformSupervisorShape
>() {}

import { Effect, Layer } from "effect";

import { UnsupportedPlatform } from "./errors.js";
import { PlatformSupervisor } from "./platform-supervisor.js";

export interface UnsupportedPlatformSupervisorOptions {
  readonly platform: string;
  readonly message?: string;
}

/**
 * Build a {@link PlatformSupervisor} layer for platforms with no registered
 * backend. Every method fails with {@link UnsupportedPlatform}, so the rest
 * of the CLI (`call`, `resume`, `web`, `mcp`) stays usable while only the
 * `service *` subcommands error out at invocation time.
 */
export const makeUnsupportedPlatformSupervisor = (
  opts: UnsupportedPlatformSupervisorOptions,
): Layer.Layer<PlatformSupervisor> => {
  const fail = <A>(): Effect.Effect<A, UnsupportedPlatform> =>
    Effect.fail(
      new UnsupportedPlatform({
        platform: opts.platform,
        message:
          opts.message ?? `No supervisor backend is registered for platform "${opts.platform}".`,
      }),
    );

  return Layer.succeed(PlatformSupervisor, {
    install: () => fail(),
    uninstall: () => fail(),
    start: () => fail(),
    stop: () => fail(),
    status: () => fail(),
  });
};

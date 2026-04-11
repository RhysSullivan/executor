import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { PlatformSupervisor } from "./platform-supervisor.js";
import { makeUnsupportedPlatformSupervisor } from "./unsupported-supervisor.js";

describe("makeUnsupportedPlatformSupervisor", () => {
  const emptySpec = {};

  it.effect("install fails with UnsupportedPlatform", () =>
    Effect.gen(function* () {
      const supervisor = yield* PlatformSupervisor;
      const exit = yield* Effect.exit(supervisor.install(emptySpec));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = exit.cause;
        const failure = err.toString();
        expect(failure).toContain("UnsupportedPlatform");
      }
    }).pipe(Effect.provide(makeUnsupportedPlatformSupervisor({ platform: "linux" }))),
  );

  it.effect("uninstall fails with UnsupportedPlatform", () =>
    Effect.gen(function* () {
      const supervisor = yield* PlatformSupervisor;
      const exit = yield* Effect.exit(supervisor.uninstall(emptySpec));
      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.provide(makeUnsupportedPlatformSupervisor({ platform: "linux" }))),
  );

  it.effect("start fails with UnsupportedPlatform", () =>
    Effect.gen(function* () {
      const supervisor = yield* PlatformSupervisor;
      const exit = yield* Effect.exit(supervisor.start(emptySpec));
      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.provide(makeUnsupportedPlatformSupervisor({ platform: "linux" }))),
  );

  it.effect("stop fails with UnsupportedPlatform", () =>
    Effect.gen(function* () {
      const supervisor = yield* PlatformSupervisor;
      const exit = yield* Effect.exit(supervisor.stop(emptySpec));
      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.provide(makeUnsupportedPlatformSupervisor({ platform: "linux" }))),
  );

  it.effect("status fails with UnsupportedPlatform", () =>
    Effect.gen(function* () {
      const supervisor = yield* PlatformSupervisor;
      const exit = yield* Effect.exit(supervisor.status(emptySpec));
      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.provide(makeUnsupportedPlatformSupervisor({ platform: "linux" }))),
  );

  it.effect("error message carries the reported platform", () =>
    Effect.gen(function* () {
      const supervisor = yield* PlatformSupervisor;
      const exit = yield* Effect.exit(supervisor.install(emptySpec));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failure = exit.cause.toString();
        expect(failure).toContain("UnsupportedPlatform");
        expect(failure).toContain("win32");
      }
    }).pipe(Effect.provide(makeUnsupportedPlatformSupervisor({ platform: "win32" }))),
  );

  it.effect("custom message overrides the default", () =>
    Effect.gen(function* () {
      const supervisor = yield* PlatformSupervisor;
      const exit = yield* Effect.exit(supervisor.install(emptySpec));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("custom override");
      }
    }).pipe(
      Effect.provide(
        makeUnsupportedPlatformSupervisor({
          platform: "linux",
          message: "custom override",
        }),
      ),
    ),
  );
});

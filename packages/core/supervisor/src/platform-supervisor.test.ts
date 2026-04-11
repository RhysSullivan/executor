import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { BootstrapFailed } from "./errors.js";
import { PlatformSupervisor, type PlatformSupervisorShape } from "./platform-supervisor.js";
import type { ServiceSpec } from "./service-spec.js";

describe("PlatformSupervisor tag", () => {
  const mockBackend: PlatformSupervisorShape = {
    install: (spec) =>
      Effect.succeed({
        label: spec.label ?? "default",
        unitFilePath: spec.unitFilePath ?? "/tmp/mock.plist",
        logPath: spec.logPath ?? "/tmp/mock.log",
        url: `http://127.0.0.1:${spec.port ?? 4788}/api/scope`,
      }),
    uninstall: () => Effect.void,
    start: () => Effect.void,
    stop: () => Effect.void,
    status: (spec) =>
      Effect.succeed({
        label: spec.label ?? "default",
        unitFilePath: spec.unitFilePath ?? "/tmp/mock.plist",
        logPath: spec.logPath ?? "/tmp/mock.log",
        url: `http://127.0.0.1:${spec.port ?? 4788}/api/scope`,
        installed: true,
        running: true,
        pid: 1234,
        reachable: true,
      }),
  };

  const mockLayer = Layer.succeed(PlatformSupervisor, mockBackend);

  it.effect("install dispatches through the tag to the provided backend", () =>
    Effect.gen(function* () {
      const supervisor = yield* PlatformSupervisor;
      const spec: ServiceSpec = { label: "sh.example.test", port: 12345 };
      const result = yield* supervisor.install(spec);
      expect(result.label).toBe("sh.example.test");
      expect(result.url).toBe("http://127.0.0.1:12345/api/scope");
    }).pipe(Effect.provide(mockLayer)),
  );

  it.effect("status dispatches and returns the backend's ServiceStatus", () =>
    Effect.gen(function* () {
      const supervisor = yield* PlatformSupervisor;
      const status = yield* supervisor.status({ label: "sh.example.test" });
      expect(status.installed).toBe(true);
      expect(status.running).toBe(true);
      expect(status.pid).toBe(1234);
    }).pipe(Effect.provide(mockLayer)),
  );

  it.effect("propagates SupervisorError from the backend", () =>
    Effect.gen(function* () {
      const failingBackend: PlatformSupervisorShape = {
        ...mockBackend,
        install: () =>
          Effect.fail(
            new BootstrapFailed({
              label: "sh.example.test",
              code: 127,
              stdout: "",
              stderr: "launchctl: command not found",
            }),
          ),
      };
      const failingLayer = Layer.succeed(PlatformSupervisor, failingBackend);

      const exit = yield* Effect.gen(function* () {
        const supervisor = yield* PlatformSupervisor;
        return yield* Effect.exit(supervisor.install({ label: "sh.example.test" }));
      }).pipe(Effect.provide(failingLayer));

      expect(exit._tag).toBe("Failure");
    }),
  );
});

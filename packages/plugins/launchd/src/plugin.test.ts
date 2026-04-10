import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ElicitationResponse, createExecutor, makeTestConfig } from "@executor/sdk";

import { launchdPlugin } from "./plugin";

describe("launchdPlugin", () => {
  it.effect("registers runtime tools with approval annotations", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            launchdPlugin({
              label: "test.executor.daemon",
              plistPath: "/tmp/test.executor.daemon.plist",
              logPath: "/tmp/test.executor.daemon.log",
            }),
          ] as const,
        }),
      );

      expect(executor.launchd.displayName).toBe("macOS launchd");
      expect(executor.launchd.isSupported).toBeTypeOf("boolean");
      expect(executor.launchd.label).toBe("test.executor.daemon");

      const tools = yield* executor.tools.list();
      const launchdTools = tools.filter((tool) => tool.pluginKey === "launchd");
      const launchdToolNames = launchdTools.map((tool) => tool.name).sort();

      expect(launchdToolNames).toEqual([
        "launchd.install",
        "launchd.start",
        "launchd.status",
        "launchd.stop",
        "launchd.uninstall",
      ]);

      const installSchema = yield* executor.tools.schema("launchd.install");
      expect(installSchema.inputSchema).toBeDefined();
    }),
  );

  it.effect("approval decline prevents mutating tool invocation", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [launchdPlugin()] as const,
        }),
      );

      const error = yield* Effect.flip(
        executor.tools.invoke(
          "launchd.install",
          {},
          {
            onElicitation: () => Effect.succeed(new ElicitationResponse({ action: "decline" })),
          },
        ),
      );

      expect(error._tag).toBe("ElicitationDeclinedError");
    }),
  );
});

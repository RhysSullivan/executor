import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  DistributionHarness,
  LocalDistributionHarnessLive,
} from "./harness";

describe("distribution flow", () => {
  const verifyInstallFlow = <R>(
    runCommand: (
      args: ReadonlyArray<string>,
      options?: {
        readonly okExitCodes?: ReadonlyArray<number>;
      },
    ) => Effect.Effect<{ stdout: string; stderr: string }, Error, R>,
  ) =>
    Effect.gen(function* () {
      const harness = yield* DistributionHarness;
      const bundleSource = readFileSync(join(harness.packageDir, "bin/executor.mjs"), "utf8");

      expect(bundleSource).not.toContain("core_bg.wasm");
      expect(
        existsSync(join(harness.packageDir, "node_modules/@1password/sdk-core/nodejs/core_bg.wasm")),
      ).toBe(true);

      yield* harness.writeProjectConfig(`{
  "runtime": "ses",
  // local workspace config
  "sources": {},
}
`);

      expect(yield* harness.isReachable()).toBe(false);

      const initialCall = yield* runCommand([
        "call",
        "return 1 + 1;",
        "--base-url",
        harness.baseUrl,
        "--no-open",
      ]);
      expect(initialCall.stdout).toBe("2");
      expect(yield* harness.isReachable()).toBe(true);

      const html = yield* harness.fetchText("/");
      expect(html.status).toBe(200);
      expect(html.contentType).toContain("text/html");
      expect(html.body).toContain("<div id=\"root\"></div>");

      const installationResponse = yield* harness.fetchText("/v1/local/installation");
      expect(installationResponse.status).toBe(200);
      const installation = JSON.parse(installationResponse.body) as {
        scopeId: string;
        actorScopeId: string;
      };

      const sesCall = yield* runCommand(
        [
          "call",
          'await fetch("https://example.com"); return 1;',
          "--base-url",
          harness.baseUrl,
        ],
        { okExitCodes: [1] },
      );
      expect(sesCall.stderr).toContain("fetch is disabled in SES executor");

      yield* harness.stopServer();
      expect(yield* harness.isReachable()).toBe(false);

      const restartedCall = yield* runCommand([
        "call",
        "return 3;",
        "--base-url",
        harness.baseUrl,
        "--no-open",
      ]);
      expect(restartedCall.stdout).toBe("3");

      const installationAfterRestartResponse = yield* harness.fetchText("/v1/local/installation");
      expect(installationAfterRestartResponse.status).toBe(200);
      const installationAfterRestart = JSON.parse(
        installationAfterRestartResponse.body,
      ) as {
        scopeId: string;
        actorScopeId: string;
      };

      expect(installationAfterRestart.scopeId).toBe(installation.scopeId);
      expect(installationAfterRestart.actorScopeId).toBe(installation.actorScopeId);

      yield* harness.stopServer();
      expect(yield* harness.isReachable()).toBe(false);
    });

  it.live("boots a staged package artifact in a fresh home", () =>
    verifyInstallFlow((args, options) =>
      Effect.flatMap(DistributionHarness, (harness) => harness.run(args, options))
    )
      .pipe(Effect.provide(LocalDistributionHarnessLive)), 240_000);

  it.live("boots an npm-installed package in a fresh home", () =>
    verifyInstallFlow((args, options) =>
      Effect.flatMap(DistributionHarness, (harness) => harness.runInstalled(args, options))
    ).pipe(Effect.provide(LocalDistributionHarnessLive)), 240_000);
});

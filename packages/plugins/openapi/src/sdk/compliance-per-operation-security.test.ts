// ---------------------------------------------------------------------------
// Compliance matrix — per-operation security overrides.
//
// OpenAPI lets each operation override the document-level `security`
// requirement. Two important cases:
//
//  1. `security: []` on an operation → NO authentication required (the
//     empty array means "anonymous"). The plugin must not attach the
//     Authorization header inherited from the source config.
//  2. A different scheme than the global → per-op wins. The plugin must
//     reach into components.securitySchemes for *this* op's scheme.
//
// STATUS ON MAIN: the plugin applies its `headers` config to every
// invocation without consulting `operation.security`, so `security: []`
// still sends the inherited Authorization header. Document the target.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "@effect/platform";

import {
  createExecutor,
  makeTestConfig,
  SecretId,
  ScopeId,
  SetSecretInput,
  type InvokeOptions,
} from "@executor/sdk";

import { openApiPlugin } from "./plugin";
import {
  getHeader,
  makeMinimalSpec,
  memorySecretsPlugin,
  startEchoServer,
} from "./compliance-helpers";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };
const TEST_SCOPE = "test-scope";

const buildExecutor = () =>
  createExecutor(
    makeTestConfig({
      plugins: [
        openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
        memorySecretsPlugin(),
      ] as const,
    }),
  );

describe("OpenAPI compliance — per-operation security", () => {
  // Skipped until per-operation security-scheme override ships (tracked
  // separately). When it lands, flip `.skip` → `.scoped` to turn this on.
  it.skip("`security: []` override drops the Authorization header", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        security: [{ bearer: [] }],
        components: {
          securitySchemes: {
            bearer: { type: "http", scheme: "bearer" },
          },
        },
        operations: [
          {
            method: "get",
            path: "/public",
            operationId: "public",
            tags: ["p"],
            security: [],
          },
        ],
      });

      const executor = yield* buildExecutor();

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("global-token"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Global token",
          value: "should-not-leak",
        }),
      );

      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "s",
        baseUrl,
        headers: {
          Authorization: { secretId: "global-token", prefix: "Bearer " },
        },
      });

      yield* executor.tools.invoke("s.p.public", {}, autoApprove);

      // The operation explicitly opted out of auth — the inherited
      // Authorization header MUST NOT reach the server.
      expect(getHeader(captured, "authorization")).toBeUndefined();
    }),
  );

  it.scoped("per-op scheme wins over global scheme", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        security: [{ apiKeyGlobal: [] }],
        components: {
          securitySchemes: {
            apiKeyGlobal: {
              type: "apiKey",
              in: "header",
              name: "X-Global-Key",
            },
            bearerPerOp: {
              type: "http",
              scheme: "bearer",
            },
          },
        },
        operations: [
          {
            method: "get",
            path: "/special",
            operationId: "special",
            tags: ["s"],
            security: [{ bearerPerOp: [] }],
          },
        ],
      });

      const executor = yield* buildExecutor();

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("op-token"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Op token",
          value: "op-tk-1",
        }),
      );

      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "s",
        baseUrl,
        // Source-level config wires the per-op bearer to a secret. The
        // global apiKey header is left unconfigured so we can assert it
        // is NOT sent.
        headers: {
          Authorization: { secretId: "op-token", prefix: "Bearer " },
        },
      });

      yield* executor.tools.invoke("s.s.special", {}, autoApprove);

      expect(getHeader(captured, "authorization")).toBe("Bearer op-tk-1");
      expect(getHeader(captured, "x-global-key")).toBeUndefined();
    }),
  );
});

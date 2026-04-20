// ---------------------------------------------------------------------------
// Compliance matrix — required-parameter / required-body enforcement.
//
// The plugin should fail fast with an OpenApiInvocationError (surfaced
// via ToolInvocationError at the executor boundary) when a required
// input is missing, rather than silently sending a request with `{id}`
// unresolved in the URL or an empty body.
//
// STATUS ON MAIN: path enforcement works. Required query / body
// enforcement is TARGET behavior.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "@effect/platform";

import {
  createExecutor,
  makeTestConfig,
  type InvokeOptions,
} from "@executor/sdk";

import { openApiPlugin } from "./plugin";
import {
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

describe("OpenAPI compliance — required enforcement", () => {
  it.scoped("missing required query param → tagged invocation error", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/search",
            operationId: "search",
            tags: ["s"],
            parameters: [
              {
                name: "q",
                in: "query",
                required: true,
                schema: { type: "string" },
              },
            ],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "r",
        baseUrl,
      });

      const err = yield* Effect.flip(
        executor.tools.invoke("r.s.search", {}, autoApprove),
      );

      // Executor wraps plugin errors in ToolInvocationError. The message
      // should mention the missing parameter so operators can debug.
      expect((err as { _tag: string })._tag).toBe("ToolInvocationError");
      expect((err as { message: string }).message.toLowerCase()).toContain("q");
    }),
  );

  it.scoped("missing required body → tagged invocation error", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "post",
            path: "/widgets",
            operationId: "create",
            tags: ["w"],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                  },
                },
              },
            },
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "r",
        baseUrl,
      });

      const err = yield* Effect.flip(
        executor.tools.invoke("r.w.create", {}, autoApprove),
      );

      expect((err as { _tag: string })._tag).toBe("ToolInvocationError");
      expect((err as { message: string }).message.toLowerCase()).toContain(
        "body",
      );
    }),
  );

  it.scoped("missing required path param → tagged invocation error", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/users/{id}",
            operationId: "getUser",
            tags: ["u"],
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "r",
        baseUrl,
      });

      const err = yield* Effect.flip(
        executor.tools.invoke("r.u.getUser", {}, autoApprove),
      );

      expect((err as { _tag: string })._tag).toBe("ToolInvocationError");
      expect((err as { message: string }).message.toLowerCase()).toContain(
        "id",
      );
    }),
  );
});

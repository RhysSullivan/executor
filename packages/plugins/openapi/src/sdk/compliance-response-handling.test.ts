// ---------------------------------------------------------------------------
// Compliance matrix — response handling.
//
// Current invoke.ts returns an `InvocationResult { status, headers, data,
// error }` where `data` carries parsed JSON (or text for non-JSON
// content-types) for 2xx and `error` carries the raw body for non-2xx.
//
// These tests document the target behaviour on the public tool-invocation
// surface: the executor re-wraps the plugin result, so these assertions
// hit `result.data` / `result.error` as the callers see them.
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

type ResultShape = {
  status?: number;
  data: unknown;
  error: unknown;
};

const buildExecutor = () =>
  createExecutor(
    makeTestConfig({
      plugins: [
        openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
        memorySecretsPlugin(),
      ] as const,
    }),
  );

describe("OpenAPI compliance — response handling", () => {
  it.scoped("200 JSON response is parsed into `data`", () =>
    Effect.gen(function* () {
      const server = yield* startEchoServer();
      server.respondWith({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: 1, name: "Acme" }),
      });

      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/thing",
            operationId: "get",
            tags: ["t"],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "r",
        baseUrl: server.baseUrl,
      });

      const result = (yield* executor.tools.invoke(
        "r.t.get",
        {},
        autoApprove,
      )) as ResultShape;

      expect(result.error).toBeNull();
      expect(result.data).toEqual({ id: 1, name: "Acme" });
    }),
  );

  it.scoped("200 text/plain response is surfaced as a raw string", () =>
    Effect.gen(function* () {
      const server = yield* startEchoServer();
      server.respondWith({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "hi there",
      });

      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/ping",
            operationId: "ping",
            tags: ["t"],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "r",
        baseUrl: server.baseUrl,
      });

      const result = (yield* executor.tools.invoke(
        "r.t.ping",
        {},
        autoApprove,
      )) as ResultShape;

      expect(result.error).toBeNull();
      expect(result.data).toBe("hi there");
    }),
  );

  it.scoped("204 No Content → data is null, no error", () =>
    Effect.gen(function* () {
      const server = yield* startEchoServer();
      server.respondWith({
        status: 204,
        headers: {},
        body: null,
      });

      const spec = makeMinimalSpec({
        operations: [
          {
            method: "delete",
            path: "/widget/1",
            operationId: "del",
            tags: ["t"],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "r",
        baseUrl: server.baseUrl,
      });

      const result = (yield* executor.tools.invoke(
        "r.t.del",
        {},
        autoApprove,
      )) as ResultShape;

      expect(result.error).toBeNull();
      expect(result.data).toBeNull();
    }),
  );

  it.scoped("4xx with JSON body → body surfaces on `error`", () =>
    Effect.gen(function* () {
      const server = yield* startEchoServer();
      server.respondWith({
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "bad_request", message: "nope" }),
      });

      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/thing",
            operationId: "get",
            tags: ["t"],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "r",
        baseUrl: server.baseUrl,
      });

      const result = (yield* executor.tools.invoke(
        "r.t.get",
        {},
        autoApprove,
      )) as ResultShape;

      expect(result.data).toBeNull();
      expect(result.error).toEqual({
        code: "bad_request",
        message: "nope",
      });
    }),
  );

  it.scoped("5xx → body surfaces on `error`", () =>
    Effect.gen(function* () {
      const server = yield* startEchoServer();
      server.respondWith({
        status: 503,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "overloaded" }),
      });

      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/thing",
            operationId: "get",
            tags: ["t"],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "r",
        baseUrl: server.baseUrl,
      });

      const result = (yield* executor.tools.invoke(
        "r.t.get",
        {},
        autoApprove,
      )) as ResultShape;

      expect(result.data).toBeNull();
      expect(result.error).toEqual({ message: "overloaded" });
    }),
  );
});

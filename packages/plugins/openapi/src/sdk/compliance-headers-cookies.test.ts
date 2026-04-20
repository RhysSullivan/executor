// ---------------------------------------------------------------------------
// Compliance matrix — header and cookie parameter serialization.
//
// STATUS ON MAIN: scalar `X-Request-Id: abc` works (plain string, direct
// setHeader). Multi-value headers (spec declares an array) are TARGET
// behavior: per OpenAPI 3 they should be joined with commas into one
// header, not ignored or stringified with `[object Object]`.
//
// Cookie parameters (`in: cookie`) are TARGET behavior — today's invoke
// loops only path/query/header, so cookie params never make it to the
// wire. Tests here document the spec-compliant target.
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
  parseCookies,
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

describe("OpenAPI compliance — header parameters", () => {
  it.scoped("scalar header: X-Request-Id is sent", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/ping",
            operationId: "ping",
            tags: ["h"],
            parameters: [
              {
                name: "X-Request-Id",
                in: "header",
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
        namespace: "h",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "h.h.ping",
        { "X-Request-Id": "abc" },
        autoApprove,
      );

      expect(getHeader(captured, "x-request-id")).toBe("abc");
    }),
  );

  it.scoped("multi-value header is comma-joined into one header line", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/ping",
            operationId: "ping",
            tags: ["h"],
            parameters: [
              {
                name: "X-Flags",
                in: "header",
                required: false,
                style: "simple",
                explode: false,
                schema: { type: "array", items: { type: "string" } },
              },
            ],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "h",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "h.h.ping",
        { "X-Flags": ["alpha", "beta", "gamma"] },
        autoApprove,
      );

      // OpenAPI 3: header arrays serialize as one comma-joined value.
      expect(getHeader(captured, "x-flags")).toBe("alpha,beta,gamma");
    }),
  );

  it.scoped("secret-resolved Authorization header smoke test", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/me",
            operationId: "me",
            tags: ["h"],
          },
        ],
      });

      const executor = yield* buildExecutor();

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("api-token"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "API token",
          value: "tk-123",
        }),
      );

      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "h",
        baseUrl,
        headers: {
          Authorization: { secretId: "api-token", prefix: "Bearer " },
        },
      });

      yield* executor.tools.invoke("h.h.me", {}, autoApprove);

      expect(getHeader(captured, "authorization")).toBe("Bearer tk-123");
    }),
  );
});

describe("OpenAPI compliance — cookie parameters", () => {
  it.scoped("single cookie: session=abc", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/me",
            operationId: "me",
            tags: ["c"],
            parameters: [
              {
                name: "session",
                in: "cookie",
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
        namespace: "c",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "c.c.me",
        { session: "abc" },
        autoApprove,
      );

      const cookie = getHeader(captured, "cookie");
      expect(cookie).toBeDefined();
      const pairs = parseCookies(cookie);
      expect(pairs).toContainEqual(["session", "abc"]);
    }),
  );

  it.scoped("multiple cookies joined with `; `: a=1; b=2", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/me",
            operationId: "me",
            tags: ["c"],
            parameters: [
              {
                name: "a",
                in: "cookie",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "b",
                in: "cookie",
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
        namespace: "c",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "c.c.me",
        { a: "1", b: "2" },
        autoApprove,
      );

      const cookie = getHeader(captured, "cookie");
      const pairs = parseCookies(cookie);
      expect(pairs).toContainEqual(["a", "1"]);
      expect(pairs).toContainEqual(["b", "2"]);
    }),
  );
});

// ---------------------------------------------------------------------------
// Compliance matrix — query parameter serialization.
//
// One test per OpenAPI query-param style. The plugin stands up a spec
// isolating the feature, invokes the tool, and we assert the exact query
// string the echo server received.
//
// STATUS ON MAIN: most of these currently fail because today's invoke.ts
// does a flat `String(value)` for every query param — it doesn't honor
// `style`, `explode`, or `deepObject`. These tests are the roadmap for the
// feature; leave them as real `it.scoped` so the output surfaces the gap.
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

describe("OpenAPI compliance — query parameters", () => {
  it.scoped("serializes a scalar string query param", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
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
        namespace: "q",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "q.s.search",
        { q: "hello" },
        autoApprove,
      );

      expect(captured.method).toBe("GET");
      expect(captured.path).toBe("/search");
      expect(captured.search).toBe("?q=hello");
    }),
  );

  it.scoped("form-exploded array: ?tag=a&tag=b", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/items",
            operationId: "list",
            tags: ["i"],
            parameters: [
              {
                name: "tag",
                in: "query",
                required: false,
                style: "form",
                explode: true,
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
        namespace: "q",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "q.i.list",
        { tag: ["a", "b"] },
        autoApprove,
      );

      // form + explode is the OpenAPI 3 default: each value gets its own
      // `tag=` pair. This is the *only* serialization that round-trips
      // cleanly through WHATWG URLSearchParams.
      expect(captured.search).toBe("?tag=a&tag=b");
    }),
  );

  it.scoped("form non-exploded array: ?tag=a,b", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/items",
            operationId: "list",
            tags: ["i"],
            parameters: [
              {
                name: "tag",
                in: "query",
                required: false,
                style: "form",
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
        namespace: "q",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "q.i.list",
        { tag: ["a", "b"] },
        autoApprove,
      );

      // form, explode: false → comma-joined in a single param.
      // RFC 6570 allows either literal "," or percent-encoded "%2C";
      // popular generators (Stoplight, OpenAPI Generator) emit the literal.
      expect(captured.search).toMatch(/^\?tag=a(,|%2C)b$/);
    }),
  );

  it.scoped("pipeDelimited array: ?tag=a|b", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/items",
            operationId: "list",
            tags: ["i"],
            parameters: [
              {
                name: "tag",
                in: "query",
                required: false,
                style: "pipeDelimited",
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
        namespace: "q",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "q.i.list",
        { tag: ["a", "b"] },
        autoApprove,
      );

      // pipeDelimited: values separated by `|`. Literal pipe is allowed
      // in query strings per RFC 3986; accept either form.
      expect(captured.search).toMatch(/^\?tag=a(\||%7C)b$/);
    }),
  );

  it.scoped("spaceDelimited array: ?tag=a%20b", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/items",
            operationId: "list",
            tags: ["i"],
            parameters: [
              {
                name: "tag",
                in: "query",
                required: false,
                style: "spaceDelimited",
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
        namespace: "q",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "q.i.list",
        { tag: ["a", "b"] },
        autoApprove,
      );

      // spaceDelimited: space-joined, space is %20 in query
      expect(captured.search).toBe("?tag=a%20b");
    }),
  );

  it.scoped("deepObject: ?user[name]=alice&user[age]=30", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/people",
            operationId: "find",
            tags: ["p"],
            parameters: [
              {
                name: "user",
                in: "query",
                required: false,
                style: "deepObject",
                explode: true,
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    age: { type: "integer" },
                  },
                },
              },
            ],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "q",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "q.p.find",
        { user: { name: "alice", age: 30 } },
        autoApprove,
      );

      // deepObject uses `param[key]=value`. `[` / `]` are reserved in
      // RFC 3986 but both `new URL()` and `fetch` preserve them unencoded,
      // and Rails-style servers expect the literal form. Accept either.
      const search = captured.search;
      expect(search).toMatch(/user(\[|%5B)name(\]|%5D)=alice/);
      expect(search).toMatch(/user(\[|%5B)age(\]|%5D)=30/);
    }),
  );

  it.scoped("percent-encodes special characters in scalar values", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
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
        namespace: "q",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "q.s.search",
        { q: "hello world" },
        autoApprove,
      );

      // space → %20 (or + in application/x-www-form-urlencoded body, but
      // this is a URL query string)
      expect(captured.search === "?q=hello%20world" || captured.search === "?q=hello+world").toBe(
        true,
      );
    }),
  );

  it.scoped("percent-encodes literal percent signs", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
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
        namespace: "q",
        baseUrl,
      });

      yield* executor.tools.invoke("q.s.search", { q: "100%" }, autoApprove);

      expect(captured.search).toBe("?q=100%25");
    }),
  );
});

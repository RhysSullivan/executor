// ---------------------------------------------------------------------------
// Wire-level tests for OpenAPI parameter serialization.
//
// These stand up a raw node http server, register a hand-authored spec with
// various `style` + `explode` combos per parameter location, invoke the
// resulting tools, and assert exactly what hit the wire (req.url /
// req.headers). The pre-change implementation used `String(value)` for
// every parameter, which silently corrupts arrays, deep objects, and
// anything that requires RFC 6570 expansion. The cases below cover:
//
//  - query form default (exploded arrays)           -> ?tag=a&tag=b
//  - query form explode=false                       -> ?tag=a,b
//  - query pipeDelimited                            -> ?tag=a|b
//  - query spaceDelimited                           -> ?tag=a%20b
//  - query deepObject                               -> ?user[name]=alice...
//  - query baseline primitive                       -> ?name=alice
//  - path label                                     -> .red.green.blue
//  - path matrix                                    -> ;color=red,green,blue
//  - cookie                                         -> Cookie: session=abc123
//  - special chars percent-encoded                  -> ?q=hello%20world
//  - missing required query param                   -> OpenApiInvocationError
//  - missing required body                          -> OpenApiInvocationError
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "@effect/platform";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createExecutor,
  definePlugin,
  makeTestConfig,
  type InvokeOptions,
  type SecretProvider,
} from "@executor/sdk";

import { openApiPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };
const TEST_SCOPE = "test-scope";

const memoryProvider: SecretProvider = (() => {
  const store = new Map<string, string>();
  return {
    key: "memory",
    writable: true,
    get: (id, scope) =>
      Effect.sync(() => store.get(`${scope}\u0000${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}\u0000${id}`, value);
      }),
    delete: (id, scope) =>
      Effect.sync(() => store.delete(`${scope}\u0000${id}`)),
    list: () => Effect.sync(() => []),
  };
})();

const memorySecretsPlugin = definePlugin(() => ({
  id: "memory-secrets" as const,
  storage: () => ({}),
  secretProviders: [memoryProvider],
}));

// ---------------------------------------------------------------------------
// Echo server — captures url + headers + method of the most recent request.
// ---------------------------------------------------------------------------

type Captured = {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: string;
};

const startEchoServer = () =>
  Effect.acquireRelease(
    Effect.async<{ baseUrl: string; captured: Captured; close: () => void }>(
      (resume) => {
        const captured: Captured = { url: "", method: "", headers: {}, body: "" };
        const server = createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            captured.url = req.url ?? "";
            captured.method = req.method ?? "";
            captured.headers = req.headers;
            captured.body = Buffer.concat(chunks).toString("utf8");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const port = (server.address() as AddressInfo).port;
          resume(
            Effect.succeed({
              baseUrl: `http://127.0.0.1:${port}`,
              captured,
              close: () => server.close(),
            }),
          );
        });
      },
    ),
    (s) => Effect.sync(() => s.close()),
  );

// ---------------------------------------------------------------------------
// Spec builder — one operation per style permutation we want to probe.
// ---------------------------------------------------------------------------

const spec = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "ParamStyleTest", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        tags: ["items"],
        parameters: [
          // Default: form + explode=true
          {
            name: "tag",
            in: "query",
            required: false,
            schema: { type: "array", items: { type: "string" } },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/items-form-collapsed": {
      get: {
        operationId: "listItemsFormCollapsed",
        tags: ["items"],
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
        responses: { "200": { description: "ok" } },
      },
    },
    "/items-pipe": {
      get: {
        operationId: "listItemsPipe",
        tags: ["items"],
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
        responses: { "200": { description: "ok" } },
      },
    },
    "/items-space": {
      get: {
        operationId: "listItemsSpace",
        tags: ["items"],
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
        responses: { "200": { description: "ok" } },
      },
    },
    "/items-deep": {
      get: {
        operationId: "listItemsDeep",
        tags: ["items"],
        parameters: [
          {
            name: "user",
            in: "query",
            required: false,
            style: "deepObject",
            explode: true,
            schema: { type: "object" },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/items-search": {
      get: {
        operationId: "searchItems",
        tags: ["items"],
        parameters: [
          {
            name: "name",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/items-required": {
      get: {
        operationId: "requiredQuery",
        tags: ["items"],
        parameters: [
          {
            name: "id",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/items-special": {
      get: {
        operationId: "specialQuery",
        tags: ["items"],
        parameters: [
          {
            name: "q",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/paint/{color}": {
      get: {
        operationId: "paintLabel",
        tags: ["paint"],
        parameters: [
          {
            name: "color",
            in: "path",
            required: true,
            style: "label",
            explode: true,
            schema: { type: "array", items: { type: "string" } },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/paint-matrix/{color}": {
      get: {
        operationId: "paintMatrix",
        tags: ["paint"],
        parameters: [
          {
            name: "color",
            in: "path",
            required: true,
            style: "matrix",
            explode: false,
            schema: { type: "array", items: { type: "string" } },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/cookie-op": {
      get: {
        operationId: "cookieOp",
        tags: ["cookies"],
        parameters: [
          {
            name: "session",
            in: "cookie",
            required: false,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/submit": {
      post: {
        operationId: "submitJson",
        tags: ["submit"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object" },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const makeExec = (baseUrl: string) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(
      makeTestConfig({
        plugins: [
          openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
          memorySecretsPlugin(),
        ] as const,
      }),
    );
    yield* executor.openapi.addSpec({
      spec,
      scope: TEST_SCOPE,
      namespace: "ps",
      baseUrl,
    });
    return executor;
  });

describe("OpenAPI parameter-style serialization", () => {
  it.scoped("array in query with default style serializes as ?tag=a&tag=b", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      yield* executor.tools.invoke(
        "ps.items.listItems",
        { tag: ["a", "b"] },
        autoApprove,
      );
      expect(captured.url).toBe("/items?tag=a&tag=b");
    }),
  );

  it.scoped("array in query with form+explode=false serializes as ?tag=a,b", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      yield* executor.tools.invoke(
        "ps.items.listItemsFormCollapsed",
        { tag: ["a", "b"] },
        autoApprove,
      );
      expect(captured.url).toBe("/items-form-collapsed?tag=a,b");
    }),
  );

  it.scoped("array in query with pipeDelimited serializes as ?tag=a|b", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      yield* executor.tools.invoke(
        "ps.items.listItemsPipe",
        { tag: ["a", "b"] },
        autoApprove,
      );
      expect(captured.url).toBe("/items-pipe?tag=a|b");
    }),
  );

  it.scoped("array in query with spaceDelimited serializes as ?tag=a%20b", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      yield* executor.tools.invoke(
        "ps.items.listItemsSpace",
        { tag: ["a", "b"] },
        autoApprove,
      );
      expect(captured.url).toBe("/items-space?tag=a%20b");
    }),
  );

  it.scoped(
    "object in query with deepObject+explode=true serializes nested bracket keys",
    () =>
      Effect.gen(function* () {
        const { baseUrl, captured } = yield* startEchoServer();
        const executor = yield* makeExec(baseUrl);
        yield* executor.tools.invoke(
          "ps.items.listItemsDeep",
          { user: { name: "alice", role: "admin" } },
          autoApprove,
        );
        expect(captured.url).toBe("/items-deep?user[name]=alice&user[role]=admin");
      }),
  );

  it.scoped("primitive query param baseline", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      yield* executor.tools.invoke(
        "ps.items.searchItems",
        { name: "alice" },
        autoApprove,
      );
      expect(captured.url).toBe("/items-search?name=alice");
    }),
  );

  it.scoped("special characters in query get percent-encoded", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      yield* executor.tools.invoke(
        "ps.items.specialQuery",
        { q: "hello world" },
        autoApprove,
      );
      expect(captured.url).toBe("/items-special?q=hello%20world");
    }),
  );

  it.scoped("path param with style=label produces a dot-prefixed segment", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      yield* executor.tools.invoke(
        "ps.paint.paintLabel",
        { color: ["red", "green", "blue"] },
        autoApprove,
      );
      expect(captured.url).toBe("/paint/.red.green.blue");
    }),
  );

  it.scoped("path param with style=matrix produces a ;-prefixed segment", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      yield* executor.tools.invoke(
        "ps.paint.paintMatrix",
        { color: ["red", "green", "blue"] },
        autoApprove,
      );
      expect(captured.url).toBe("/paint-matrix/;color=red,green,blue");
    }),
  );

  it.scoped("cookie parameter is emitted as a Cookie header", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      yield* executor.tools.invoke(
        "ps.cookies.cookieOp",
        { session: "abc123" },
        autoApprove,
      );
      expect(captured.headers.cookie).toBe("session=abc123");
    }),
  );

  it.scoped("missing required query param fails with OpenApiInvocationError", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      const err = yield* Effect.flip(
        executor.tools.invoke("ps.items.requiredQuery", {}, autoApprove),
      );
      // The executor wraps plugin errors as ToolInvocationError; the
      // underlying message must call out the missing parameter so the
      // LLM (or a human) knows exactly what to supply.
      expect(String((err as { message?: string }).message ?? "")).toContain(
        "Missing required query parameter: id",
      );
    }),
  );

  it.scoped("missing required body fails with OpenApiInvocationError", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startEchoServer();
      const executor = yield* makeExec(baseUrl);
      const err = yield* Effect.flip(
        executor.tools.invoke("ps.submit.submitJson", {}, autoApprove),
      );
      expect(String((err as { message?: string }).message ?? "")).toContain(
        "Missing required request body",
      );
    }),
  );
});

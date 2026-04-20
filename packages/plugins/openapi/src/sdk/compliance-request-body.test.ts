// ---------------------------------------------------------------------------
// Compliance matrix — request body serialization.
//
// STATUS ON MAIN: JSON + string bodies work. form-urlencoded with an
// object body currently ships `[object Object]` (see
// form-urlencoded-body.test.ts for the regression — this file keeps the
// scenario alongside the rest of the body matrix for easy comparison).
// multipart/form-data is TARGET behavior — not implemented. text/plain
// and the "no body declared" case are regressions worth locking in.
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

describe("OpenAPI compliance — request body", () => {
  it.scoped("application/json body is JSON-encoded on the wire", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
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
                    properties: {
                      name: { type: "string" },
                      qty: { type: "integer" },
                    },
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
        namespace: "b",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "b.w.create",
        { body: { name: "thing", qty: 3 } },
        autoApprove,
      );

      expect(captured.method).toBe("POST");
      expect(getHeader(captured, "content-type")).toMatch(/application\/json/);
      expect(JSON.parse(captured.body)).toEqual({ name: "thing", qty: 3 });
    }),
  );

  it.scoped("application/x-www-form-urlencoded body encodes object fields", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "post",
            path: "/submit",
            operationId: "submit",
            tags: ["f"],
            requestBody: {
              required: true,
              content: {
                "application/x-www-form-urlencoded": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      email: { type: "string" },
                    },
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
        namespace: "b",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "b.f.submit",
        { body: { name: "Acme", email: "a@b.com" } },
        autoApprove,
      );

      expect(getHeader(captured, "content-type")).toMatch(
        /application\/x-www-form-urlencoded/,
      );
      expect(captured.body).not.toBe("[object Object]");

      const parsed = new URLSearchParams(captured.body);
      expect(parsed.get("name")).toBe("Acme");
      expect(parsed.get("email")).toBe("a@b.com");
    }),
  );

  it.scoped("multipart/form-data sets a boundary and includes each field", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "post",
            path: "/upload",
            operationId: "upload",
            tags: ["m"],
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      note: { type: "string" },
                    },
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
        namespace: "b",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "b.m.upload",
        { body: { title: "hello", note: "world" } },
        autoApprove,
      );

      const ct = getHeader(captured, "content-type") ?? "";
      expect(ct).toMatch(/^multipart\/form-data/);
      expect(ct).toMatch(/boundary=/);

      // Each field should appear as a Content-Disposition block.
      expect(captured.body).toMatch(/name="title"/);
      expect(captured.body).toContain("hello");
      expect(captured.body).toMatch(/name="note"/);
      expect(captured.body).toContain("world");
    }),
  );

  it.scoped("text/plain body passes a raw string through", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "post",
            path: "/note",
            operationId: "note",
            tags: ["t"],
            requestBody: {
              required: true,
              content: {
                "text/plain": { schema: { type: "string" } },
              },
            },
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "b",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "b.t.note",
        { body: "hello, plain" },
        autoApprove,
      );

      expect(getHeader(captured, "content-type")).toMatch(/text\/plain/);
      expect(captured.body).toBe("hello, plain");
    }),
  );

  it.scoped("no body declared → no body sent on GET", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/ping",
            operationId: "ping",
            tags: ["n"],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "b",
        baseUrl,
      });

      yield* executor.tools.invoke("b.n.ping", {}, autoApprove);

      expect(captured.method).toBe("GET");
      // For a GET with no requestBody, the plugin must not invent a body
      // or a Content-Type header.
      expect(captured.body).toBe("");
      const ct = getHeader(captured, "content-type");
      expect(ct === undefined || ct === "").toBe(true);
    }),
  );
});

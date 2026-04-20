// ---------------------------------------------------------------------------
// Compliance matrix — path parameter serialization.
//
// STATUS ON MAIN: scalar `/users/42` works. Array (`simple` style),
// `label` style (`.1.2.3`), `matrix` style (`;id=1,2,3`), and
// `allowReserved` pass-through are TARGET behavior and will currently
// fail — the plugin percent-encodes `encodeURIComponent(String(value))`
// for every path param regardless of style. Tests encode the desired
// target so the feature work has a goalpost.
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

describe("OpenAPI compliance — path parameters", () => {
  it.scoped("scalar simple: /users/42", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
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
                schema: { type: "integer" },
              },
            ],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "p",
        baseUrl,
      });

      yield* executor.tools.invoke("p.u.getUser", { id: 42 }, autoApprove);

      expect(captured.method).toBe("GET");
      expect(captured.path).toBe("/users/42");
    }),
  );

  it.scoped("array simple (explode:false): /users/1,2,3", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/users/{ids}",
            operationId: "getMany",
            tags: ["u"],
            parameters: [
              {
                name: "ids",
                in: "path",
                required: true,
                style: "simple",
                explode: false,
                schema: { type: "array", items: { type: "integer" } },
              },
            ],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "p",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "p.u.getMany",
        { ids: [1, 2, 3] },
        autoApprove,
      );

      // `simple` style with `explode: false` → comma-joined values.
      // OpenAPI 3 semantics: commas in the path value are NOT encoded.
      expect(captured.path).toBe("/users/1,2,3");
    }),
  );

  it.scoped("label style (non-exploded): /users/.1,2,3", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/users/{ids}",
            operationId: "getMany",
            tags: ["u"],
            parameters: [
              {
                name: "ids",
                in: "path",
                required: true,
                style: "label",
                explode: false,
                schema: { type: "array", items: { type: "integer" } },
              },
            ],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "p",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "p.u.getMany",
        { ids: [1, 2, 3] },
        autoApprove,
      );

      // RFC 6570 §3.2.5: {.list} (non-exploded) → ".red,green,blue"
      // (dots separate list values only with `{.list*}` — explode: true).
      expect(captured.path).toBe("/users/.1,2,3");
    }),
  );

  it.scoped("matrix style: /users/;id=1,2,3", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/users/{id}",
            operationId: "getMany",
            tags: ["u"],
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                style: "matrix",
                explode: false,
                schema: { type: "array", items: { type: "integer" } },
              },
            ],
          },
        ],
      });

      const executor = yield* buildExecutor();
      yield* executor.openapi.addSpec({
        spec,
        scope: TEST_SCOPE,
        namespace: "p",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "p.u.getMany",
        { id: [1, 2, 3] },
        autoApprove,
      );

      // matrix style: `;name=v1,v2,v3` when explode is false
      expect(captured.path).toBe("/users/;id=1,2,3");
    }),
  );

  it.scoped("reserved chars are percent-encoded by default", () =>
    Effect.gen(function* () {
      const { baseUrl, captured } = yield* startEchoServer();
      const spec = makeMinimalSpec({
        operations: [
          {
            method: "get",
            path: "/items/{key}",
            operationId: "get",
            tags: ["i"],
            parameters: [
              {
                name: "key",
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
        namespace: "p",
        baseUrl,
      });

      // `/` is a reserved path delimiter — absent `allowReserved`, it
      // MUST be percent-encoded (%2F) so the server sees one path segment.
      yield* executor.tools.invoke("p.i.get", { key: "a/b" }, autoApprove);

      expect(captured.path).toBe("/items/a%2Fb");
    }),
  );
});

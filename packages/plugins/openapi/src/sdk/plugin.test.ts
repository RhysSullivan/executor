import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpClient,
  HttpServerRequest,
  OpenApi,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";

import {
  createExecutor,
  makeInMemoryPolicyEngine,
  makeInMemorySecretStore,
  makeInMemorySourceRegistry,
  makeInMemoryToolRegistry,
  makeTestConfig,
  ScopeId,
  SecretId,
  type InvokeOptions,
} from "@executor/core";
import { openApiPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// Define a test API with Effect HttpApi
// ---------------------------------------------------------------------------

class Item extends Schema.Class<Item>("Item")({
  id: Schema.Number,
  name: Schema.String,
}) {}

class EchoHeaders extends Schema.Class<EchoHeaders>("EchoHeaders")({
  authorization: Schema.optional(Schema.String),
  "x-static": Schema.optional(Schema.String),
}) {}

const ItemsGroup = HttpApiGroup.make("items")
  .add(
    HttpApiEndpoint.get("listItems", "/items").addSuccess(Schema.Array(Item)),
  )
  .add(
    HttpApiEndpoint.get("getItem", "/items/:itemId")
      .setPath(Schema.Struct({ itemId: Schema.NumberFromString }))
      .addSuccess(Item),
  )
  .add(
    HttpApiEndpoint.get("echoHeaders", "/echo-headers").addSuccess(EchoHeaders),
  );

const TestApi = HttpApi.make("testApi").add(ItemsGroup);

const spec = OpenApi.fromApi(TestApi);
const specJson = JSON.stringify(spec);

// ---------------------------------------------------------------------------
// Implement handlers
// ---------------------------------------------------------------------------

const ITEMS = [
  { id: 1, name: "Widget" },
  { id: 2, name: "Gadget" },
  { id: 3, name: "Doohickey" },
];

const ItemsGroupLive = HttpApiBuilder.group(TestApi, "items", (handlers) =>
  handlers
    .handle("listItems", () => Effect.succeed(ITEMS))
    .handle("getItem", (req) =>
      Effect.succeed(
        ITEMS.find((i) => i.id === req.path.itemId) ?? {
          id: 0,
          name: "Unknown",
        },
      ),
    )
    .handle("echoHeaders", () =>
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        return new EchoHeaders({
          authorization: req.headers["authorization"],
          "x-static": req.headers["x-static"],
        });
      }),
    ),
);

// ---------------------------------------------------------------------------
// Test layer: real server on port 0 + HttpClient pointing at it
// ---------------------------------------------------------------------------

const ApiLive = HttpApiBuilder.api(TestApi).pipe(
  Layer.provide(ItemsGroupLive),
);

const TestLayer = HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

// ---------------------------------------------------------------------------
// Tests — layer() shares the server across all tests in this describe block
// ---------------------------------------------------------------------------

layer(TestLayer)("OpenAPI Plugin", (it) => {
  it.effect("previewSpec returns metadata and header presets", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      const preview = yield* executor.openapi.previewSpec(specJson);

      expect(preview.operationCount).toBeGreaterThanOrEqual(2);
      expect(preview.servers).toBeDefined();
    }),
  );

  it.effect("registers runtime openapi tools under built-in source", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      const tools = yield* executor.tools.list();
      const ids = tools.map((t) => t.id);
      expect(ids).toContain("openapi.previewSpec");
      expect(ids).toContain("openapi.addSource");
    }),
  );

  it.effect("lists built-in as a runtime source", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      const sources = yield* executor.sources.list();

      expect(sources).toContainEqual(expect.objectContaining({
        id: "built-in",
        name: "Built In",
        kind: "built-in",
        runtime: true,
        canRemove: false,
        canRefresh: false,
      }));
    }),
  );

  it.effect("closing an executor does not remove added source tools from the shared registry", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const scope = {
        id: ScopeId.make("test-scope"),
        name: "/test",
        createdAt: new Date(),
      } as const;

      const sharedConfig = {
        scope,
        tools: makeInMemoryToolRegistry(),
        sources: makeInMemorySourceRegistry(),
        secrets: makeInMemorySecretStore(),
        policies: makeInMemoryPolicyEngine(),
      };

      const executor1 = yield* createExecutor({
        ...sharedConfig,
        plugins: [
          openApiPlugin({ httpClientLayer: clientLayer }),
        ] as const,
      });

      yield* executor1.openapi.addSpec({
        spec: specJson,
        namespace: "persisted",
      });

      expect((yield* executor1.tools.list()).map((tool) => tool.id)).toContain(
        "persisted.items.listItems",
      );

      yield* executor1.close();

      const executor2 = yield* createExecutor({
        ...sharedConfig,
        plugins: [
          openApiPlugin({ httpClientLayer: clientLayer }),
        ] as const,
      });

      expect((yield* executor2.tools.list()).map((tool) => tool.id)).toContain(
        "persisted.items.listItems",
      );
    }),
  );

  it.effect("invokes runtime previewSpec through executor.tools.invoke", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      const result = yield* executor.tools.invoke(
        "openapi.previewSpec",
        { spec: specJson },
        autoApprove,
      );

      expect(result.error).toBeNull();
      expect((result.data as { operationCount: number }).operationCount).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect("invokes runtime addSource through executor.tools.invoke", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      const result = yield* executor.tools.invoke(
        "openapi.addSource",
        { spec: specJson, namespace: "runtime" },
        autoApprove,
      );

      expect(result.error).toBeNull();
      expect(result.data).toEqual({ sourceId: "runtime", toolCount: 3 });
      expect((yield* executor.tools.list()).map((t) => t.id)).toContain(
        "runtime.items.listItems",
      );
    }),
  );

  it.effect("resolves secret-backed headers at invocation time", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      // Store a secret
      yield* executor.secrets.set({
        id: SecretId.make("test-api-token"),
        name: "Test API Token",
        value: "secret-value-123",
      });

      // Add spec with secret-backed header
      yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "authed",
        baseUrl: "",
        headers: {
          "Authorization": { secretId: "test-api-token", prefix: "Bearer " },
          "X-Static": "hello",
        },
      });

      // Invoke the echo endpoint — verifies secret was resolved and sent
      const result = yield* executor.tools.invoke(
        "authed.items.echoHeaders",
        {},
        autoApprove,
      );

      expect(result.error).toBeNull();
      const data = result.data as { authorization?: string; "x-static"?: string };
      expect(data.authorization).toBe("Bearer secret-value-123");
      expect(data["x-static"]).toBe("hello");
    }),
  );

  it.effect("fails clearly when a secret is missing", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      // Add spec with secret-backed header but DON'T store the secret
      yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "noauth",
        baseUrl: "",
        headers: {
          "Authorization": { secretId: "missing-token", prefix: "Bearer " },
        },
      });

      // Invoke — should fail with a clear error about the missing secret
      const error = yield* Effect.flip(
        executor.tools.invoke("noauth.items.listItems", {}, autoApprove),
      );

      expect(error._tag).toBe("ToolInvocationError");
      expect((error as { message: string }).message).toContain("missing-token");
    }),
  );

  it.effect("registers tools from an OpenAPI spec", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      const result = yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "test",
        baseUrl: "",
      });

      expect(result.toolCount).toBeGreaterThanOrEqual(2);

      const tools = yield* executor.tools.list();
      const names = tools.map((t) => t.name);
      expect(names).toContain("items.listItems");
      expect(names).toContain("items.getItem");
    }),
  );

  it.effect("invokes listItems", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "test",
        baseUrl: "",
      });

      const result = yield* executor.tools.invoke("test.items.listItems", {}, autoApprove);
      expect(result.error).toBeNull();
      expect(result.data).toEqual(ITEMS);
    }),
  );

  it.effect("invokes getItem with path parameter", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "test",
        baseUrl: "",
      });

      const result = yield* executor.tools.invoke("test.items.getItem", {
        itemId: "2",
      }, autoApprove);
      expect(result.error).toBeNull();
      expect(result.data).toEqual({ id: 2, name: "Gadget" });
    }),
  );

  it.effect("removeSpec cleans up registered tools", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "removable",
        baseUrl: "",
      });

      expect((yield* executor.tools.list()).length).toBeGreaterThan(0);

      yield* executor.openapi.removeSpec("removable");

      const remaining = yield* executor.tools.list();
      expect(remaining.map((tool) => tool.id)).toEqual([
        "openapi.previewSpec",
        "openapi.addSource",
      ]);
    }),
  );
});

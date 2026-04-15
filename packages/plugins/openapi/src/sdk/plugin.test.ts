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
  definePlugin,
  makeTestConfig,
  SecretId,
  SetSecretInput,
  type InvokeOptions,
  type SecretProvider,
} from "@executor/sdk";
import { openApiPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// In-memory secrets provider plugin — registered alongside openapi so
// executor.secrets.set/get work in tests.
// ---------------------------------------------------------------------------

const memoryProvider: SecretProvider = (() => {
  const store = new Map<string, string>();
  return {
    key: "memory",
    writable: true,
    get: (id) => Effect.sync(() => store.get(id) ?? null),
    set: (id, value) =>
      Effect.sync(() => {
        store.set(id, value);
      }),
    delete: (id) => Effect.sync(() => store.delete(id)),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((id) => ({ id, name: id })),
      ),
  };
})();

const memorySecretsPlugin = definePlugin(() => ({
  id: "memory-secrets" as const,
  storage: () => ({}),
  secretProviders: [memoryProvider],
}));

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
  .add(HttpApiEndpoint.get("listItems", "/items").addSuccess(Schema.Array(Item)))
  .add(
    HttpApiEndpoint.get("getItem", "/items/:itemId")
      .setPath(Schema.Struct({ itemId: Schema.NumberFromString }))
      .addSuccess(Item),
  )
  .add(HttpApiEndpoint.get("echoHeaders", "/echo-headers").addSuccess(EchoHeaders));

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

const ApiLive = HttpApiBuilder.api(TestApi).pipe(Layer.provide(ItemsGroupLive));

const TestLayer = HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

// ---------------------------------------------------------------------------
// Tests
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
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const preview = yield* executor.openapi.previewSpec(specJson);

      expect(preview.operationCount).toBeGreaterThanOrEqual(2);
      expect(preview.servers).toBeDefined();
    }),
  );

  it.effect("registers static openapi control tools", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const tools = yield* executor.tools.list();
      const ids = tools.map((t) => t.id);
      expect(ids).toContain("openapi.previewSpec");
      expect(ids).toContain("openapi.addSource");
    }),
  );

  it.effect("lists openapi as a static runtime source", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const sources = yield* executor.sources.list();
      const control = sources.find((s) => s.id === "openapi");
      expect(control).toBeDefined();
      expect(control!.runtime).toBe(true);
      expect(control!.canRemove).toBe(false);
    }),
  );

  it.effect("invokes static previewSpec through executor.tools.invoke", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const result = (yield* executor.tools.invoke(
        "openapi.previewSpec",
        { spec: specJson },
        autoApprove,
      )) as { operationCount: number };

      expect(result.operationCount).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect("invokes static addSource through executor.tools.invoke", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const result = (yield* executor.tools.invoke(
        "openapi.addSource",
        { spec: specJson, namespace: "runtime" },
        autoApprove,
      )) as { sourceId: string; toolCount: number };

      expect(result).toEqual({ sourceId: "runtime", toolCount: 3 });
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
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("test-api-token"),
          name: "Test API Token",
          value: "secret-value-123",
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "authed",
        baseUrl: "",
        headers: {
          Authorization: { secretId: "test-api-token", prefix: "Bearer " },
          "X-Static": "hello",
        },
      });

      const result = (yield* executor.tools.invoke(
        "authed.items.echoHeaders",
        {},
        autoApprove,
      )) as { data: { authorization?: string; "x-static"?: string } | null; error: unknown };

      expect(result.error).toBeNull();
      const data = result.data!;
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
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "noauth",
        baseUrl: "",
        headers: {
          Authorization: { secretId: "missing-token", prefix: "Bearer " },
        },
      });

      const error = yield* Effect.flip(
        executor.tools.invoke("noauth.items.listItems", {}, autoApprove),
      );

      expect((error as { _tag: string })._tag).toBe("ToolInvocationError");
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
            memorySecretsPlugin(),
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
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "test",
        baseUrl: "",
      });

      const result = (yield* executor.tools.invoke(
        "test.items.listItems",
        {},
        autoApprove,
      )) as { data: unknown; error: unknown };
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
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "test",
        baseUrl: "",
      });

      const result = (yield* executor.tools.invoke(
        "test.items.getItem",
        { itemId: "2" },
        autoApprove,
      )) as { data: unknown; error: unknown };
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
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        namespace: "removable",
        baseUrl: "",
      });

      expect((yield* executor.tools.list()).length).toBeGreaterThan(2);

      yield* executor.openapi.removeSpec("removable");

      const remaining = yield* executor.tools.list();
      const ids = remaining.map((t) => t.id).sort();
      expect(ids).toEqual([
        "openapi.addSource",
        "openapi.previewSpec",
      ]);
    }),
  );
});

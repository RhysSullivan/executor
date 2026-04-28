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
  type DBAdapter,
  definePlugin,
  makeTestConfig,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  type InvokeOptions,
  type SecretProvider,
  type Where,
} from "@executor/sdk";

const TEST_SCOPE = "test-scope";
import { openApiPlugin } from "./plugin";
import { OAuth2Auth } from "./types";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

type FindManyCall = {
  readonly model: string;
  readonly where?: readonly Where[];
};

const recordFindMany = (
  adapter: DBAdapter,
  calls: FindManyCall[],
): DBAdapter => ({
  ...adapter,
  findMany: (data) => {
    calls.push({ model: data.model, where: data.where });
    return adapter.findMany(data);
  },
  transaction: (callback) =>
    adapter.transaction((trx) =>
      callback({
        ...trx,
        findMany: (data) => {
          calls.push({ model: data.model, where: data.where });
          return trx.findMany(data);
        },
      }),
    ),
});

// ---------------------------------------------------------------------------
// In-memory secrets provider plugin — registered alongside openapi so
// executor.secrets.set/get work in tests.
// ---------------------------------------------------------------------------

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
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((k) => {
          const name = k.split("\u0000", 2)[1] ?? k;
          return { id: name, name };
        }),
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
          scope: ScopeId.make(TEST_SCOPE),
          name: "Test API Token",
          value: "secret-value-123",
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
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
        scope: TEST_SCOPE,
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
        scope: TEST_SCOPE,
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
        scope: TEST_SCOPE,
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
        scope: TEST_SCOPE,
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
        scope: TEST_SCOPE,
        namespace: "removable",
        baseUrl: "",
      });

      expect((yield* executor.tools.list()).length).toBeGreaterThan(2);

      yield* executor.openapi.removeSpec("removable", TEST_SCOPE);

      const remaining = yield* executor.tools.list();
      const ids = remaining.map((t) => t.id).sort();
      expect(ids).toEqual([
        "openapi.addSource",
        "openapi.previewSpec",
      ]);
    }),
  );

  // -------------------------------------------------------------------------
  // Multi-scope shadowing — regression suite covering the bug class where
  // store reads/writes that don't pin scope_id collapse onto whichever row
  // the scoped adapter's `scope_id IN (stack)` filter sees first. Each
  // scenario is reproducible against the pre-fix store.
  // -------------------------------------------------------------------------

  const ORG_SCOPE = ScopeId.make("org-scope");
  const USER_SCOPE = ScopeId.make("user-scope");

  const stackedScopes = [
    new Scope({ id: USER_SCOPE, name: "user", createdAt: new Date() }),
    new Scope({ id: ORG_SCOPE, name: "org", createdAt: new Date() }),
  ] as const;

  it.effect("shadowed addSpec does not wipe the outer-scope source", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      // Org-level base source
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: ORG_SCOPE as string,
        namespace: "shared",
        baseUrl: "",
        name: "Org Source",
      });

      // Per-user shadow with the same namespace
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: USER_SCOPE as string,
        namespace: "shared",
        baseUrl: "",
        name: "User Source",
      });

      const userView = yield* executor.openapi.getSource("shared", USER_SCOPE as string);
      const orgView = yield* executor.openapi.getSource("shared", ORG_SCOPE as string);

      // Both rows must coexist — innermost-wins reads come from the
      // executor; the store's scope-pinned getters return the exact row.
      expect(userView?.name).toBe("User Source");
      expect(userView?.scope).toBe(USER_SCOPE as string);
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.scope).toBe(ORG_SCOPE as string);
    }),
  );

  it.effect("getSource resolves inherited config without listing every OpenAPI source", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const config = makeTestConfig({
        scopes: stackedScopes,
        plugins: [
          openApiPlugin({ httpClientLayer: clientLayer }),
          memorySecretsPlugin(),
        ] as const,
      });
      const findManyCalls: FindManyCall[] = [];

      const executor = yield* createExecutor({
        ...config,
        adapter: recordFindMany(config.adapter, findManyCalls),
      });

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: ORG_SCOPE as string,
        namespace: "shared",
        baseUrl: "https://org.example.com",
        name: "Org Source",
      });
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: USER_SCOPE as string,
        namespace: "shared",
        baseUrl: "",
        name: "User Source",
      });

      findManyCalls.length = 0;
      const userView = yield* executor.openapi.getSource("shared", USER_SCOPE as string);

      expect(userView?.config.baseUrl).toBe("https://org.example.com");
      expect(findManyCalls.some((call) => call.model === "openapi_source")).toBe(false);
    }),
  );

  it.effect("removeSpec on user shadow leaves the org row intact", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: ORG_SCOPE as string,
        namespace: "shared",
        baseUrl: "",
        name: "Org Source",
      });
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: USER_SCOPE as string,
        namespace: "shared",
        baseUrl: "",
        name: "User Source",
      });

      yield* executor.openapi.removeSpec("shared", USER_SCOPE as string);

      const userView = yield* executor.openapi.getSource("shared", USER_SCOPE as string);
      const orgView = yield* executor.openapi.getSource("shared", ORG_SCOPE as string);

      expect(userView).toBeNull();
      expect(orgView?.name).toBe("Org Source");
    }),
  );

  it.effect("updateSource on user shadow does not mutate the org row", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: ORG_SCOPE as string,
        namespace: "shared",
        baseUrl: "https://org.example.com",
        name: "Org Source",
      });
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: USER_SCOPE as string,
        namespace: "shared",
        baseUrl: "https://user.example.com",
        name: "User Source",
      });

      yield* executor.openapi.updateSource("shared", USER_SCOPE as string, {
        name: "User Renamed",
        baseUrl: "https://user-new.example.com",
      });

      const userView = yield* executor.openapi.getSource("shared", USER_SCOPE as string);
      const orgView = yield* executor.openapi.getSource("shared", ORG_SCOPE as string);

      expect(userView?.name).toBe("User Renamed");
      expect(userView?.config.baseUrl).toBe("https://user-new.example.com");
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.config.baseUrl).toBe("https://org.example.com");
    }),
  );

  it.effect(
    "addSpec persists a source with deferred OAuth2Auth (no live connection yet)",
    () =>
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

        // A team-shared client id secret, but no live connection for this
        // scope — the admin is saving the source and deferring sign-in
        // to individual users.
        yield* executor.secrets.set(
          new SetSecretInput({
            id: SecretId.make("acme-client-id"),
            scope: ScopeId.make(TEST_SCOPE),
            name: "Acme Client ID",
            value: "client-abc",
          }),
        );

        const deferredAuth = new OAuth2Auth({
          kind: "oauth2",
          connectionId: "openapi-oauth2-pending-deferred",
          securitySchemeName: "oauth2",
          flow: "authorizationCode",
          tokenUrl: "https://auth.example.com/token",
          authorizationUrl: "https://auth.example.com/authorize",
          clientIdSecretId: "acme-client-id",
          clientSecretSecretId: null,
          scopes: ["read:items"],
        });

        const result = yield* executor.openapi.addSpec({
          spec: specJson,
          scope: TEST_SCOPE,
          namespace: "deferred",
          baseUrl: "https://api.example.com",
          oauth2: deferredAuth,
        });

        expect(result.toolCount).toBeGreaterThan(0);

        const stored = yield* executor.openapi.getSource("deferred", TEST_SCOPE);
        expect(stored).not.toBeNull();
        expect(stored?.config.oauth2?.flow).toBe("authorizationCode");
        expect(stored?.config.oauth2?.connectionSlot).toBe("oauth2:oauth2:connection");
        expect(stored?.config.oauth2?.clientIdSlot).toBe("oauth2:oauth2:client-id");

        const clientIdBinding = yield* executor.openapi
          .listSourceBindings("deferred", TEST_SCOPE)
          .pipe(
            Effect.map((bindings) =>
              bindings.find(
                (binding) => binding.slot === stored!.config.oauth2!.clientIdSlot,
              ) ?? null,
            ),
          );
        expect(clientIdBinding?.value).toEqual({
          kind: "secret",
          secretId: SecretId.make("acme-client-id"),
        });

        const connectionBinding = yield* executor.openapi
          .listSourceBindings("deferred", TEST_SCOPE)
          .pipe(
            Effect.map((bindings) =>
              bindings.find(
                (binding) => binding.slot === stored!.config.oauth2!.connectionSlot,
              ) ?? null,
            ),
          );
        expect(connectionBinding?.value).toEqual({
          kind: "connection",
          connectionId: "openapi-oauth2-pending-deferred",
        });

        // Tools should be listed even without a live connection; invocation
        // is what requires the token, not registration.
        const tools = yield* executor.tools.list();
        expect(tools.some((t) => t.id.startsWith("deferred."))).toBe(true);
      }),
  );
});

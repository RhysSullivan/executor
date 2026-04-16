// Tenant isolation integration test. Runs in plain node (not workerd)
// via vitest.node.config.ts — workerd's dev-mode compile stack crashes
// on the full cloud module graph (MCP SDK + all plugin handlers).
//
// Every plugin is the real one. `createScopedExecutor` is mirrored inline
// here instead of imported so the `workos-vault` plugin gets an
// in-memory fake `WorkOSVaultClient` (the real client would try to
// reach the WorkOS API with test creds). Everything else — core
// adapter, plugins, DbService, ProtectedCloudApi, HttpApiClient —
// runs the same code the worker serves in prod.
//
// The only auth swap: `OrgAuthLive` (WorkOS cookie) is replaced with a
// `FakeOrgAuthLive` that reads `x-test-org-id`.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiSwagger,
  HttpApp,
  HttpServer,
  HttpServerRequest,
} from "@effect/platform";

import {
  ExecutionEngineService,
  ExecutorService,
} from "@executor/api/server";
import { createExecutionEngine } from "@executor/execution";
import {
  Scope,
  ScopeId,
  SecretId,
  collectSchemas,
  createExecutor,
} from "@executor/sdk";
import {
  makePostgresAdapter,
  makePostgresBlobStore,
} from "@executor/storage-postgres";
import { openApiPlugin } from "@executor/plugin-openapi";
import { mcpPlugin } from "@executor/plugin-mcp";
import { graphqlPlugin } from "@executor/plugin-graphql";
import {
  workosVaultPlugin,
  WorkOSVaultClientError,
  type WorkOSVaultClient,
  type WorkOSVaultObject,
  type WorkOSVaultObjectMetadata,
} from "@executor/plugin-workos-vault";
import { OpenApiExtensionService } from "@executor/plugin-openapi/api";
import { McpExtensionService } from "@executor/plugin-mcp/api";
import { GraphqlExtensionService } from "@executor/plugin-graphql/api";

import { AuthContext, OrgAuth } from "../auth/middleware";
import {
  ProtectedCloudApi,
  ProtectedCloudApiHandlers,
  RouterConfig,
} from "../api/protected-layers";
import { DbService } from "./db";

const TEST_BASE_URL = "http://test.local";
const TEST_ORG_HEADER = "x-test-org-id";

// ---------------------------------------------------------------------------
// Fake WorkOS Vault client — in-memory map keyed by name. Real client
// would talk to WorkOS's API, which we don't want from tests.
// ---------------------------------------------------------------------------

const makeFakeVaultClient = (): WorkOSVaultClient => {
  const byName = new Map<string, WorkOSVaultObject>();
  let seq = 0;
  const nextId = () => `vault_${++seq}_${crypto.randomUUID().slice(0, 8)}`;

  const create = (opts: { name: string; value: string; context: Record<string, string> }) => {
    const id = nextId();
    const metadata: WorkOSVaultObjectMetadata = {
      context: opts.context,
      id,
      updatedAt: new Date(),
      versionId: `v_${seq}`,
    };
    byName.set(opts.name, { id, name: opts.name, value: opts.value, metadata });
    return metadata;
  };

  const notFound = (name: string) =>
    Object.assign(new Error(`not found: ${name}`), { status: 404 });

  const read = (name: string): WorkOSVaultObject => {
    const obj = byName.get(name);
    if (!obj) throw notFound(name);
    return obj;
  };

  const update = (opts: { id: string; value: string }): WorkOSVaultObject => {
    for (const [name, obj] of byName.entries()) {
      if (obj.id === opts.id) {
        const updated: WorkOSVaultObject = {
          ...obj,
          value: opts.value,
          metadata: { ...obj.metadata, updatedAt: new Date(), versionId: `v_${++seq}` },
        };
        byName.set(name, updated);
        return updated;
      }
    }
    throw notFound(opts.id);
  };

  const remove = (opts: { id: string }) => {
    for (const [name, obj] of byName.entries()) {
      if (obj.id === opts.id) byName.delete(name);
    }
  };

  return {
    use: (_op, fn) =>
      Effect.tryPromise({
        try: () =>
          fn({
            createObject: async (opts) => create(opts),
            readObjectByName: async (name) => read(name),
            updateObject: async (opts) => update(opts),
            deleteObject: async (opts) => remove(opts),
          }),
        catch: (cause) => new Error(String(cause)) as never,
      }) as never,
    // The real client wraps SDK rejections in WorkOSVaultClientError so
    // provider-side `isStatusError` checks can introspect `cause.status`.
    // Mirror that here so our 404s flow through the same unwrap path.
    createObject: (opts) =>
      Effect.try({
        try: () => create(opts),
        catch: (cause) => new WorkOSVaultClientError({ cause, operation: "create_object" }),
      }),
    readObjectByName: (name) =>
      Effect.try({
        try: () => read(name),
        catch: (cause) =>
          new WorkOSVaultClientError({ cause, operation: "read_object_by_name" }),
      }),
    updateObject: (opts) =>
      Effect.try({
        try: () => update(opts),
        catch: (cause) => new WorkOSVaultClientError({ cause, operation: "update_object" }),
      }),
    deleteObject: (opts) =>
      Effect.try({
        try: () => remove(opts),
        catch: (cause) => new WorkOSVaultClientError({ cause, operation: "delete_object" }),
      }),
  };
};

// ---------------------------------------------------------------------------
// Executor factory — mirrors apps/cloud/services/executor#createScopedExecutor
// but with a fake vault client.
// ---------------------------------------------------------------------------

const fakeVault = makeFakeVaultClient();

const createTestOrgExecutor = (orgId: string, orgName: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const plugins = [
      openApiPlugin(),
      mcpPlugin({ dangerouslyAllowStdioMCP: false }),
      graphqlPlugin(),
      workosVaultPlugin({ client: fakeVault }),
    ] as const;
    const schema = collectSchemas(plugins);
    const adapter = makePostgresAdapter({ db, schema });
    const blobs = makePostgresBlobStore({ db });
    const scope = new Scope({
      id: ScopeId.make(orgId),
      name: orgName,
      createdAt: new Date(),
    });
    return yield* createExecutor({ scope, adapter, blobs, plugins });
  });

// ---------------------------------------------------------------------------
// HTTP plumbing — build the ProtectedCloudApi app with FakeOrgAuth and
// dispatch requests to it via a FetchHttpClient layer.
// ---------------------------------------------------------------------------

const FakeOrgAuthLive = Layer.succeed(
  OrgAuth,
  OrgAuth.of({
    cookie: () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const orgId = request.headers[TEST_ORG_HEADER];
        if (!orgId || typeof orgId !== "string") {
          return yield* Effect.die(new Error("missing x-test-org-id"));
        }
        return AuthContext.of({
          accountId: `acct_${orgId}`,
          organizationId: orgId,
          email: "test@example.com",
          name: "Test User",
          avatarUrl: null,
        });
      }),
  }),
);

const TestApiLive = HttpApiBuilder.api(ProtectedCloudApi).pipe(
  Layer.provide(Layer.merge(ProtectedCloudApiHandlers, FakeOrgAuthLive)),
);

const buildAppForOrg = (orgId: string, orgName: string) =>
  Effect.gen(function* () {
    const executor = yield* createTestOrgExecutor(orgId, orgName);
    const engine = createExecutionEngine({ executor });
    const services = Layer.mergeAll(
      Layer.succeed(ExecutorService, executor),
      Layer.succeed(ExecutionEngineService, engine),
      Layer.succeed(OpenApiExtensionService, executor.openapi),
      Layer.succeed(McpExtensionService, executor.mcp),
      Layer.succeed(GraphqlExtensionService, executor.graphql),
    );
    return yield* HttpApiBuilder.httpApp.pipe(
      Effect.provide(
        HttpApiSwagger.layer({ path: "/docs" }).pipe(
          Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
          Layer.provideMerge(TestApiLive),
          Layer.provideMerge(services),
          Layer.provideMerge(RouterConfig),
          Layer.provideMerge(HttpServer.layerContext),
          Layer.provideMerge(HttpApiBuilder.Router.Live),
          Layer.provideMerge(HttpApiBuilder.Middleware.layer),
        ),
      ),
    );
  });

const RouterApp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const orgId = request.headers[TEST_ORG_HEADER];
  if (!orgId || typeof orgId !== "string") {
    return yield* Effect.die(new Error("missing x-test-org-id"));
  }
  return yield* yield* buildAppForOrg(orgId, `Org ${orgId}`);
});

const handler = HttpApp.toWebHandler(
  RouterApp.pipe(
    Effect.provide(DbService.Live),
    Effect.provide(HttpServer.layerContext),
  ),
);

const fetchForOrg = (orgId: string): typeof globalThis.fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const base = input instanceof Request ? input : new Request(input, init);
    const req = new Request(base, {
      headers: { ...Object.fromEntries(base.headers), [TEST_ORG_HEADER]: orgId },
    });
    return handler(req);
  }) as typeof globalThis.fetch;

const clientLayerForOrg = (orgId: string) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchForOrg(orgId))),
  );

const MINIMAL_OPENAPI_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Tenant Test API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tenant isolation (HTTP)", () => {
  it.effect("sources.list does not leak across orgs", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        yield* client.openapi.addSpec({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { spec: MINIMAL_OPENAPI_SPEC, namespace: namespaceA },
        });
      }).pipe(Effect.provide(clientLayerForOrg(orgA)));

      const orgBSources = yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        return yield* client.sources.list({ path: { scopeId: ScopeId.make(orgB) } });
      }).pipe(Effect.provide(clientLayerForOrg(orgB)));

      expect(orgBSources.map((s) => s.id)).not.toContain(namespaceA);
    }),
  );

  it.effect("tools.list does not leak across orgs", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        yield* client.openapi.addSpec({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { spec: MINIMAL_OPENAPI_SPEC, namespace: namespaceA },
        });
      }).pipe(Effect.provide(clientLayerForOrg(orgA)));

      const orgBTools = yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        return yield* client.tools.list({ path: { scopeId: ScopeId.make(orgB) } });
      }).pipe(Effect.provide(clientLayerForOrg(orgB)));

      expect(orgBTools.map((t) => t.sourceId)).not.toContain(namespaceA);
    }),
  );

  it.effect("openapi.getSource cannot reach another org's source by namespace", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        yield* client.openapi.addSpec({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { spec: MINIMAL_OPENAPI_SPEC, namespace: namespaceA },
        });
      }).pipe(Effect.provide(clientLayerForOrg(orgA)));

      const result = yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        return yield* client.openapi
          .getSource({ path: { scopeId: ScopeId.make(orgB), namespace: namespaceA } })
          .pipe(Effect.either);
      }).pipe(Effect.provide(clientLayerForOrg(orgB)));

      if (result._tag === "Right") {
        expect(result.right).toBeNull();
      }
    }),
  );

  it.effect("secrets.list does not leak across orgs", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const secretIdA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        yield* client.secrets.set({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(secretIdA), name: "org-a only", value: "super-secret-a" },
        });
      }).pipe(Effect.provide(clientLayerForOrg(orgA)));

      const orgBSecrets = yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        return yield* client.secrets.list({ path: { scopeId: ScopeId.make(orgB) } });
      }).pipe(Effect.provide(clientLayerForOrg(orgB)));

      expect(orgBSecrets.map((s) => s.id)).not.toContain(secretIdA);
    }),
  );

  it.effect("secrets.status reports another org's secret as missing", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const secretIdA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        yield* client.secrets.set({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(secretIdA), name: "org-a only", value: "super-secret-a" },
        });
      }).pipe(Effect.provide(clientLayerForOrg(orgA)));

      const result = yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        return yield* client.secrets
          .status({ path: { scopeId: ScopeId.make(orgB), secretId: SecretId.make(secretIdA) } })
          .pipe(Effect.either);
      }).pipe(Effect.provide(clientLayerForOrg(orgB)));

      if (result._tag === "Right") {
        expect(result.right.status).toBe("missing");
      }
    }),
  );

  it.effect("secrets.resolve cannot return another org's plaintext", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const secretIdA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        yield* client.secrets.set({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(secretIdA), name: "org-a only", value: "super-secret-a" },
        });
      }).pipe(Effect.provide(clientLayerForOrg(orgA)));

      const result = yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
        return yield* client.secrets
          .resolve({ path: { scopeId: ScopeId.make(orgB), secretId: SecretId.make(secretIdA) } })
          .pipe(Effect.either);
      }).pipe(Effect.provide(clientLayerForOrg(orgB)));

      expect(result._tag).toBe("Left");
    }),
  );
});

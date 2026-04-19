// Shared HTTP test harness for node-pool integration tests.
//
// Stands up the real ProtectedCloudApi against a real DbService and
// every real plugin (openapi / mcp / graphql / workos-vault), with
// two test-only swaps:
//
//   - `OrgAuthLive` is replaced with `FakeOrgAuthLive`, which reads
//     the scope id off `x-test-org-id` instead of the WorkOS cookie.
//   - `workos-vault` is configured with an in-memory `WorkOSVaultClient`
//     so secret writes never reach WorkOS's real API.
//
// Tests get a `fetchForOrg(orgId)` they can hand to `FetchHttpClient`
// and then call `HttpApiClient.make(ProtectedCloudApi)` against it.
// Each test picks its own org id (usually a random UUID) so rows don't
// collide across tests.

import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpApi,
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
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";
import {
  Scope,
  ScopeId,
  ScopeStack,
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

import { AuthContext, OrgAuth } from "../../auth/middleware";
import {
  ProtectedCloudApi,
  ProtectedCloudApiHandlers,
  RouterConfig,
} from "../../api/protected-layers";
import { DbService } from "../db";

export const TEST_BASE_URL = "http://test.local";
export const TEST_ORG_HEADER = "x-test-org-id";
export const TEST_USER_HEADER = "x-test-user-id";
// `/scopes/<scopeId>/...` — the URL's scope segment selects the write
// target for the request, mirroring the prod `protected.ts` plumbing.
// When the URL scopeId is in the caller's read chain it becomes the
// write target; otherwise the innermost scope (user) is used.
const SCOPE_PATH_REGEX = /\/scopes\/([^/]+)/;
const extractUrlScopeId = (url: string): string | null => {
  try {
    const pathname = new URL(url, "http://x").pathname;
    const match = pathname.match(SCOPE_PATH_REGEX);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
};
const deriveUserScopeId = (accountId: string): string => `user_${accountId}`;

// ---------------------------------------------------------------------------
// Fake WorkOS Vault client — in-memory map keyed by name.
// ---------------------------------------------------------------------------

export const makeFakeVaultClient = (): WorkOSVaultClient => {
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

interface TestExecutorOptions {
  readonly read: readonly { readonly id: string; readonly name: string }[];
  readonly writeScopeId?: string;
}

const createTestScopedExecutor = (options: TestExecutorOptions) =>
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

    const read = options.read.map(
      (s) =>
        new Scope({
          id: ScopeId.make(s.id),
          name: s.name,
          createdAt: new Date(),
        }),
    );
    const write = options.writeScopeId
      ? read.find((s) => s.id === options.writeScopeId)
      : read[0];
    if (!write) {
      return yield* Effect.die(
        new Error(`writeScopeId ${options.writeScopeId} not in read chain`),
      );
    }
    const scope = new ScopeStack({ read, write });
    return yield* createExecutor({ scope, adapter, blobs, plugins });
  });

// ---------------------------------------------------------------------------
// HTTP plumbing
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
        const userHeader = request.headers[TEST_USER_HEADER];
        // Default account id = `acct_<orgId>` so tests that don't set
        // `x-test-user-id` still get a stable, per-org identity (the
        // single-user-per-org world the cloud stack used to model).
        const accountId =
          typeof userHeader === "string" && userHeader.length > 0
            ? userHeader
            : `acct_${orgId}`;
        return AuthContext.of({
          accountId,
          userScopeId: deriveUserScopeId(accountId),
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

interface BuildAppOptions {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly userScopeId: string;
  readonly userName: string;
  readonly writeScopeId: string;
}

const buildAppForScope = (options: BuildAppOptions) =>
  Effect.gen(function* () {
    const executor = yield* createTestScopedExecutor({
      read: [
        { id: options.userScopeId, name: options.userName },
        { id: options.organizationId, name: options.organizationName },
      ],
      writeScopeId: options.writeScopeId,
    });
    const engine = createExecutionEngine({ executor, codeExecutor: makeQuickJsExecutor() });
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
  const userHeader = request.headers[TEST_USER_HEADER];
  const accountId =
    typeof userHeader === "string" && userHeader.length > 0
      ? userHeader
      : `acct_${orgId}`;
  const userScopeId = deriveUserScopeId(accountId);
  const urlScopeId = extractUrlScopeId(request.url);
  // URL scope only becomes write target if the caller can actually
  // reach it — otherwise fall back to the innermost (user) scope.
  const writeScopeId =
    urlScopeId === orgId || urlScopeId === userScopeId
      ? urlScopeId
      : userScopeId;
  return yield* yield* buildAppForScope({
    organizationId: orgId,
    organizationName: `Org ${orgId}`,
    userScopeId,
    userName: accountId,
    writeScopeId,
  });
});

const handler = HttpApp.toWebHandler(
  RouterApp.pipe(
    Effect.provide(DbService.Live),
    Effect.provide(HttpServer.layerContext),
  ),
);

export const fetchForOrg = (orgId: string, userId?: string): typeof globalThis.fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const base = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {
      ...Object.fromEntries(base.headers),
      [TEST_ORG_HEADER]: orgId,
    };
    if (userId) headers[TEST_USER_HEADER] = userId;
    const req = new Request(base, { headers });
    return handler(req);
  }) as typeof globalThis.fetch;

export const clientLayerForOrg = (orgId: string, userId?: string) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchForOrg(orgId, userId))),
  );

// Constructs an HttpApiClient bound to the given org, hands it to `body`,
// and provides the org-scoped fetch layer in one step. Keeps per-test
// Effect blocks focused on the actual assertions.
type ApiShape = typeof ProtectedCloudApi extends HttpApi.HttpApi<
  infer _Id,
  infer Groups,
  infer ApiError,
  infer _ApiR
>
  ? HttpApiClient.Client<Groups, ApiError, never>
  : never;

export const asOrg = <A, E>(
  orgId: string,
  body: (client: ApiShape) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
    return yield* body(client);
  }).pipe(Effect.provide(clientLayerForOrg(orgId))) as Effect.Effect<A, E>;

// Scope helper for per-user tests. `userId` is the synthetic account id
// (test chooses); `userScopeId` is what it maps to in the read chain.
export const userScopeIdFor = (userId: string): string => deriveUserScopeId(userId);

export const asUser = <A, E>(
  orgId: string,
  userId: string,
  body: (client: ApiShape) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
    return yield* body(client);
  }).pipe(Effect.provide(clientLayerForOrg(orgId, userId))) as Effect.Effect<A, E>;

// Re-exports so call sites don't need a second import.
export { ProtectedCloudApi };

// Shared HTTP test harness for node-pool integration tests.
//
// Stands up the real ProtectedCloudApi against a real DbService and
// every real plugin (openapi / mcp / graphql / workos-vault), with
// two test-only swaps:
//
//   - Auth is faked: the executor binds `{ tenant, subject }` read off the
//     `x-test-org-id` / `x-test-user-id` headers instead of the WorkOS cookie.
//   - `workos-vault` is configured with an in-memory `WorkOSVaultClient`
//     so connection writes never reach WorkOS's real API.
//
// Tests get a `fetchForOrg(organizationId)` they can hand to `FetchHttpClient`
// and then call `HttpApiClient.make(ProtectedCloudApi)` against it.
// Each test picks its own org id (usually a random UUID) so rows don't
// collide across tests.
//
// v2: the executor is bound to a tenant (the organization id) and a subject
// (the account id). The org-shared catalog is `owner: "org"`; a member's own
// connections are `owner: "user"`. There is no scope stack and no scope id.

import { Effect, Layer } from "effect";
import { HttpApiBuilder, HttpApiClient, HttpApiSwagger } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";

import {
  ExecutionEngineService,
  ExecutorService,
  collectTables,
  providePluginExtensions,
  type PluginExtensionServices,
} from "@executor-js/api/server";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { createExecutor, Subject, Tenant } from "@executor-js/sdk";
import { makeTestWorkOSVaultClient } from "@executor-js/plugin-workos-vault/testing";

import executorConfig from "../../executor.config";
import { AuthContext, RouterConfigLive } from "@executor-js/api/server";

import { ProtectedCloudApi, ProtectedCloudApiHandlers } from "../api/layers";
import { DbService } from "../db/db";
import { createDrizzleFumaDb } from "../db/fuma";

export const TEST_BASE_URL = "http://test.local";
export const TEST_ORG_HEADER = "x-test-org-id";
export const TEST_USER_HEADER = "x-test-user-id";

// `asOrg(organizationId, …)` callers don't care which specific user they are,
// only that the executor has a bound subject so `owner: "user"` operations work.
// We give each org a stable default subject so list/get operations remain
// deterministic across calls within a single test.
const defaultUserFor = (organizationId: string) => `default_user_${organizationId}`;

// ---------------------------------------------------------------------------
// Executor factory — mirrors `makeScopedExecutor` (binds `{ tenant, subject }`)
// but with an in-memory test vault client (see
// `@executor-js/plugin-workos-vault/testing`).
// ---------------------------------------------------------------------------

const fakeVault = makeTestWorkOSVaultClient();
const testPlugins = executorConfig.plugins({
  workosVaultClient: fakeVault,
});
const testHttpClientLayer = FetchHttpClient.layer;

const createTestScopedExecutor = (userId: string, organizationId: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const plugins = testPlugins;
    const fuma = createDrizzleFumaDb({
      db,
      tables: collectTables(),
      namespace: "executor_cloud",
      provider: "postgresql",
    });
    return yield* createExecutor({
      tenant: Tenant.make(organizationId),
      subject: Subject.make(userId),
      db: fuma.db,
      plugins,
      httpClientLayer: testHttpClientLayer,
      onElicitation: "accept-all",
      // EXPLICIT OAuth callback — production derives
      // `${webBaseUrl}${CLOUD_MOUNT_PREFIX}/oauth/callback` in `makeScopedExecutor`
      // (the cloud mounts the API under `/api`); the harness wires the matching
      // stable test equivalent so the OAuth `start` (authorization_code) flow
      // returns a redirect instead of failing loudly on the now-required redirectUri.
      redirectUri: "https://test.executor.sh/api/oauth/callback",
    });
  });

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

// Test version of the production `ExecutionStackMiddleware` — reads the
// `x-test-org-id` (and optional `x-test-user-id`) header, builds a
// test-scoped executor against the live postgres test db with a fake
// WorkOS vault, and provides `AuthContext` + the executor services to the
// handler. Mirrors prod's HttpRouter middleware but with test-mode
// constructors.
const TestExecutionStackMiddleware = HttpRouter.middleware<{
  provides:
    | AuthContext
    | ExecutorService
    | ExecutionEngineService
    | PluginExtensionServices<typeof testPlugins>;
}>()(
  // Layer-time setup — captures `DbService` so the per-request function
  // only depends on `HttpRouter`-Provided context. See `api/protected.ts`
  // for the same pattern.
  Effect.gen(function* () {
    const context = yield* Effect.context<DbService>();
    const provideExecutorExtensions = providePluginExtensions(testPlugins);
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const organizationId = request.headers[TEST_ORG_HEADER];
        if (!organizationId || typeof organizationId !== "string") {
          // oxlint-disable-next-line executor/no-effect-escape-hatch, executor/no-error-constructor -- boundary: test HTTP harness has no request context without x-test-org-id
          return yield* Effect.die(new Error("missing x-test-org-id"));
        }
        const userHeader = request.headers[TEST_USER_HEADER];
        const userId =
          typeof userHeader === "string" && userHeader.length > 0
            ? userHeader
            : defaultUserFor(organizationId);
        const executor = yield* createTestScopedExecutor(userId, organizationId);
        const engine = createExecutionEngine({
          executor,
          codeExecutor: makeQuickJsExecutor(),
        });
        return yield* httpEffect.pipe(
          Effect.provideService(
            AuthContext,
            AuthContext.of({
              accountId: userId,
              organizationId,
              email: "test@example.com",
              name: "Test User",
              avatarUrl: null,
              roles: [],
            }),
          ),
          Effect.provideService(ExecutorService, executor),
          Effect.provideService(ExecutionEngineService, engine),
          provideExecutorExtensions(executor),
        );
      }).pipe(Effect.provideContext(context));
  }),
).layer;

const TestApiLive = HttpApiBuilder.layer(ProtectedCloudApi).pipe(
  Layer.provide(ProtectedCloudApiHandlers),
  Layer.provide(TestExecutionStackMiddleware),
  Layer.provideMerge(HttpApiSwagger.layer(ProtectedCloudApi, { path: "/docs" })),
  Layer.provideMerge(RouterConfigLive),
  Layer.provideMerge(DbService.Live),
  Layer.provideMerge(HttpServer.layerServices),
);

const handler = HttpRouter.toWebHandler(TestApiLive, { disableLogger: true }).handler;

export const fetchForOrg = (organizationId: string): typeof globalThis.fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const base = input instanceof Request ? input : new Request(input, init);
    const req = new Request(base, {
      headers: { ...Object.fromEntries(base.headers), [TEST_ORG_HEADER]: organizationId },
    });
    return handler(req);
  }) as typeof globalThis.fetch;

export const fetchForUser = (userId: string, organizationId: string): typeof globalThis.fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const base = input instanceof Request ? input : new Request(input, init);
    const req = new Request(base, {
      headers: {
        ...Object.fromEntries(base.headers),
        [TEST_ORG_HEADER]: organizationId,
        [TEST_USER_HEADER]: userId,
      },
    });
    return handler(req);
  }) as typeof globalThis.fetch;

export const clientLayerForOrg = (organizationId: string) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetchForOrg(organizationId))),
  );

export const clientLayerForUser = (userId: string, organizationId: string) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetchForUser(userId, organizationId))),
  );

// Constructs an HttpApiClient bound to the given org, hands it to `body`,
// and provides the org-scoped fetch layer in one step. Keeps per-test
// Effect blocks focused on the actual assertions.
type ApiShape = HttpApiClient.ForApi<typeof ProtectedCloudApi>;

export const asOrg = <A, E>(
  organizationId: string,
  body: (client: ApiShape) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
    return yield* body(client);
  }).pipe(Effect.provide(clientLayerForOrg(organizationId))) as Effect.Effect<A, E>;

// Same as `asOrg` but also threads a specific user id through the fake auth, so
// the built executor's bound subject is `userId`. Use this for tests that care
// about per-user isolation (`owner: "user"` connections) inside the same org.
export const asUser = <A, E>(
  userId: string,
  organizationId: string,
  body: (client: ApiShape) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(ProtectedCloudApi, { baseUrl: TEST_BASE_URL });
    return yield* body(client);
  }).pipe(Effect.provide(clientLayerForUser(userId, organizationId))) as Effect.Effect<A, E>;

// Re-exports so call sites don't need a second import.
export { ProtectedCloudApi };

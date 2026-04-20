// ---------------------------------------------------------------------------
// End-to-end shape test for multi-user bearer-token auth on the OpenAPI
// plugin. Models the Vercel-style scenario:
//
//   - An org admin uploads the Vercel OpenAPI spec once. The stored source
//     carries an `Authorization: Bearer <vercel_api_token>` header
//     reference, but NOT the token value itself.
//   - Each user (alice, bob) writes their own personal access token at
//     their own user scope under the same secret id (`vercel_api_token`).
//   - Invoking a Vercel tool through alice injects alice's token;
//     through bob injects bob's. The org scope never stores a value —
//     per-user scopes are the only source of truth for the bearer.
//
// This is the tier-1 win: the scope-partitioning `SecretProvider` lets
// the same secret id carry a distinct value in each user's scope, so a
// single stored source description serves every user without duplicating
// source rows per tenant.
// ---------------------------------------------------------------------------

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
  collectSchemas,
  createExecutor,
  definePlugin,
  makeInMemoryBlobStore,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  type InvokeOptions,
  type SecretProvider,
} from "@executor/sdk";
import { makeMemoryAdapter } from "@executor/storage-core/testing/memory";

import { openApiPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// Test API — a single endpoint that echoes the Authorization header so the
// test can assert which user's token got injected.
// ---------------------------------------------------------------------------

class EchoHeaders extends Schema.Class<EchoHeaders>("EchoHeaders")({
  authorization: Schema.optional(Schema.String),
}) {}

const ProjectsGroup = HttpApiGroup.make("projects").add(
  HttpApiEndpoint.get("list", "/v9/projects").addSuccess(EchoHeaders),
);

const VercelApi = HttpApi.make("vercelApi").add(ProjectsGroup);
const specJson = JSON.stringify(OpenApi.fromApi(VercelApi));

const ProjectsGroupLive = HttpApiBuilder.group(VercelApi, "projects", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return new EchoHeaders({
        authorization: req.headers["authorization"],
      });
    }),
  ),
);

const ApiLive = HttpApiBuilder.api(VercelApi).pipe(Layer.provide(ProjectsGroupLive));

const TestLayer = HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestLayer)("OpenAPI multi-scope bearer (Vercel-style)", (it) => {
  it.effect(
    "admin-added source; each user's per-scope token wins on invocation",
    () =>
      Effect.gen(function* () {
        // Scope-partitioning in-memory provider. The composite key is
        // what makes the tier-1 fix observable: same secret id, different
        // value per scope. A flat `Map<id, value>` provider would lose
        // one of the users' tokens on the second write.
        const secretStore = new Map<string, string>();
        const key = (scope: string, id: string) => `${scope}\u0000${id}`;
        const memoryProvider: SecretProvider = {
          key: "memory",
          writable: true,
          get: (id, scope) =>
            Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
          set: (id, value, scope) =>
            Effect.sync(() => {
              secretStore.set(key(scope, id), value);
            }),
          delete: (id, scope) =>
            Effect.sync(() => secretStore.delete(key(scope, id))),
        };
        const memorySecretsPlugin = definePlugin(() => ({
          id: "memory-secrets" as const,
          storage: () => ({}),
          secretProviders: [memoryProvider],
        }));

        const httpClient = yield* HttpClient.HttpClient;
        const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
        const plugins = [
          openApiPlugin({ httpClientLayer: clientLayer }),
          memorySecretsPlugin(),
        ] as const;

        // One adapter + blob store backing all three executors: mirrors a
        // multi-tenant deployment where admin + users share infra but
        // each sits at a different scope stack.
        const schema = collectSchemas(plugins);
        const adapter = makeMemoryAdapter({ schema });
        const blobs = makeInMemoryBlobStore();

        const now = new Date();
        const orgScope = new Scope({
          id: ScopeId.make("org"),
          name: "acme-org",
          createdAt: now,
        });
        const aliceScope = new Scope({
          id: ScopeId.make("user-alice"),
          name: "alice",
          createdAt: now,
        });
        const bobScope = new Scope({
          id: ScopeId.make("user-bob"),
          name: "bob",
          createdAt: now,
        });

        const adminExec = yield* createExecutor({
          scopes: [orgScope],
          adapter,
          blobs,
          plugins,
        });
        const aliceExec = yield* createExecutor({
          scopes: [aliceScope, orgScope],
          adapter,
          blobs,
          plugins,
        });
        const bobExec = yield* createExecutor({
          scopes: [bobScope, orgScope],
          adapter,
          blobs,
          plugins,
        });

        // -------------------------------------------------------------
        // 1. Admin adds the Vercel OpenAPI source at org scope. The
        //    stored source carries a HeaderValue *reference* to the
        //    secret id — the value itself is deliberately NOT written
        //    at the org scope. Each user will supply their own.
        // -------------------------------------------------------------
        yield* adminExec.openapi.addSpec({
          spec: specJson,
          scope: orgScope.id as string,
          namespace: "vercel",
          baseUrl: "",
          headers: {
            Authorization: {
              secretId: "vercel_api_token",
              prefix: "Bearer ",
            },
          },
        });

        // -------------------------------------------------------------
        // 2. Each user writes their personal access token under the
        //    same secret id, but at their own scope. Tier-1 scope
        //    routing means these coexist in the provider — alice's
        //    write does not overwrite bob's.
        // -------------------------------------------------------------
        yield* aliceExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("vercel_api_token"),
            scope: aliceScope.id,
            name: "Vercel API Token (alice)",
            value: "alice-vercel-token",
          }),
        );
        yield* bobExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("vercel_api_token"),
            scope: bobScope.id,
            name: "Vercel API Token (bob)",
            value: "bob-vercel-token",
          }),
        );

        // -------------------------------------------------------------
        // 3. Invoking the shared tool through each user's executor
        //    resolves `vercel_api_token` via scope fall-through
        //    (innermost first). Alice's scope yields her token; bob's
        //    scope yields his. Same source, same tool, different
        //    injected bearer.
        // -------------------------------------------------------------
        const aliceResult = (yield* aliceExec.tools.invoke(
          "vercel.projects.list",
          {},
          autoApprove,
        )) as { data: { authorization?: string } | null; error: unknown };
        expect(aliceResult.error).toBeNull();
        expect(aliceResult.data?.authorization).toBe("Bearer alice-vercel-token");

        const bobResult = (yield* bobExec.tools.invoke(
          "vercel.projects.list",
          {},
          autoApprove,
        )) as { data: { authorization?: string } | null; error: unknown };
        expect(bobResult.error).toBeNull();
        expect(bobResult.data?.authorization).toBe("Bearer bob-vercel-token");

        // -------------------------------------------------------------
        // 4. Scope attribution: each user's token is pinned to their
        //    own scope, never smuggled into the org fallback.
        // -------------------------------------------------------------
        const aliceRows = yield* aliceExec.secrets.list();
        const aliceToken = aliceRows.find(
          (r) => (r.id as unknown as string) === "vercel_api_token",
        );
        expect(aliceToken?.scopeId as unknown as string).toBe("user-alice");

        const bobRows = yield* bobExec.secrets.list();
        const bobToken = bobRows.find(
          (r) => (r.id as unknown as string) === "vercel_api_token",
        );
        expect(bobToken?.scopeId as unknown as string).toBe("user-bob");

        // Admin's scope never received a token — `get` at the org
        // scope yields null and the source is effectively unusable
        // for the admin role, exactly as designed.
        const adminToken = yield* adminExec.secrets.get("vercel_api_token");
        expect(adminToken).toBeNull();

        // -------------------------------------------------------------
        // 5. Cross-user isolation on enumeration: alice does not see
        //    bob's token row, and vice versa.
        // -------------------------------------------------------------
        const aliceIds = new Set(
          aliceRows.map((r) => `${r.scopeId as unknown as string}:${r.id as unknown as string}`),
        );
        expect(aliceIds).toContain("user-alice:vercel_api_token");
        expect(aliceIds).not.toContain("user-bob:vercel_api_token");

        const bobIds = new Set(
          bobRows.map((r) => `${r.scopeId as unknown as string}:${r.id as unknown as string}`),
        );
        expect(bobIds).toContain("user-bob:vercel_api_token");
        expect(bobIds).not.toContain("user-alice:vercel_api_token");
      }),
  );
});

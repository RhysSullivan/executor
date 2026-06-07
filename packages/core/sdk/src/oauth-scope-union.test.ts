import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Predicate, type Scope } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolName,
} from "./ids";
import type { AuthMethodDescriptor } from "./integration";
import { definePlugin, type IntegrationRecord } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// Integration-driven scopes: at connect, `oauth.start` requests EXACTLY the
// integration's DECLARED oauth scopes. The OAuth app carries no scope set of its
// own, so there is no union and no over-request — the integration is the sole
// source of what to request. (Replaces the earlier declared∪client union model.)

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");

// The integration's DECLARED oauth scopes — the sole source of the request.
const DECLARED_SCOPES = ["calendar", "gmail", "drive", "sheets"] as const;

/** A plugin whose integration config carries declared oauth scopes, projected
 *  into an oauth `AuthMethodDescriptor` via `describeAuthMethods` — exactly the
 *  shape `resolveDeclaredOAuthScopes` reads. `scopes: null` ⇒ no declared oauth
 *  scopes (the MCP/no-template-scopes case). */
const makeScopePlugin = (config: { readonly scopes: readonly string[] | null }) =>
  definePlugin(() => ({
    id: "acme" as const,
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({
        tools: [{ name: ToolName.make("whoami"), description: "whoami" }],
      }),
    invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
    describeAuthMethods: (record: IntegrationRecord): readonly AuthMethodDescriptor[] => {
      const cfg = record.config as { readonly scopes?: readonly string[] | null } | null;
      const scopes = cfg?.scopes;
      if (scopes == null) {
        // No declared oauth scopes — the integration declares an oauth method
        // with no template scopes (MCP/DCR-style). Declared scopes resolve to [].
        return [{ id: "oauth", label: "OAuth2", kind: "oauth", template: String(TEMPLATE) }];
      }
      return [
        {
          id: "oauth",
          label: "OAuth2",
          kind: "oauth",
          template: String(TEMPLATE),
          oauth: { scopes },
        },
      ];
    },
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({
          slug: INTEG,
          description: "Acme",
          config: { scopes: config.scopes },
        }),
    }),
  }))();

/** Parse the `scope` query param from an authorize URL into an ordered list. */
const scopesFromAuthorizeUrl = (authorizationUrl: string): readonly string[] => {
  const raw = new URL(authorizationUrl).searchParams.get("scope");
  return raw == null || raw.length === 0 ? [] : raw.split(" ");
};

describe("oauth.start integration-driven scopes", () => {
  it.effect(
    "(a) requests exactly the integration's declared scopes (the app contributes none)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOAuthTestServer({ scopes: [...DECLARED_SCOPES] });
          const plugins = [
            memoryCredentialsPlugin(),
            makeScopePlugin({ scopes: DECLARED_SCOPES }),
          ] as const;
          const { executor } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.acme.seed();

          // The app is pure identity — no scope set.
          yield* executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: server.authorizationEndpoint,
            tokenUrl: server.tokenEndpoint,
            grant: "authorization_code",
            clientId: "test-client",
            clientSecret: "test-secret",
          });

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;

          // The authorize URL requests exactly the integration's declared scopes.
          expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([...DECLARED_SCOPES]);
        }),
      ),
  );

  it.effect("(b) when the integration declares no oauth scopes, start requests none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: [] });
        // `scopes: null` ⇒ the integration declares an oauth method with no
        // template scopes ⇒ declared scopes resolve to [] ⇒ no scope is requested.
        const plugins = [memoryCredentialsPlugin(), makeScopePlugin({ scopes: null })] as const;
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([]);
      }),
    ),
  );
});

// -----------------------------------------------------------------------------
// (c) The recorded `oauth_scope` reflects the requested (declared) scopes when
// the AS omits `scope`. A minimal inline token endpoint handles the
// client_credentials grant and deliberately OMITS `scope` from its response,
// forcing the recorded-scope fallback (`token.scope ?? requested.join(" ")`).
// -----------------------------------------------------------------------------

/** A minimal token endpoint serving the client_credentials grant and OMITTING
 *  `scope` from its response, forcing the recorded-scope fallback. Returns a
 *  scoped effect (mirrors `serveOAuthTestServer`); `yield*` it inside an already
 *  `Effect.scoped` test. */
const serveScopelessTokenServer = (): Effect.Effect<
  { readonly tokenEndpoint: string },
  unknown,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.fresh(
        HttpServer.serve(
          HttpServerRequest.HttpServerRequest.asEffect().pipe(
            Effect.map((request: HttpServerRequest.HttpServerRequest) => {
              if (request.url.startsWith("/token") && request.method === "POST") {
                // A Bearer access token WITHOUT a `scope` field — the AS omits
                // it, so the recorded scope falls back to the requested set.
                return HttpServerResponse.jsonUnsafe(
                  {
                    access_token: `at_${Math.random().toString(36).slice(2)}`,
                    token_type: "Bearer",
                    expires_in: 3600,
                  },
                  { status: 200, headers: { "cache-control": "no-store" } },
                );
              }
              return HttpServerResponse.jsonUnsafe({ error: "not_found" }, { status: 404 });
            }),
          ),
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      ),
    );
    const server = Context.get(context, HttpServer.HttpServer);
    const address = server.address;
    if (!Predicate.isTagged(address, "TcpAddress")) {
      return yield* Effect.die(`Expected a TcpAddress, got ${JSON.stringify(address)}`);
    }
    return { tokenEndpoint: `http://127.0.0.1:${address.port}/token` };
  });

describe("oauth.start recorded scope fallback", () => {
  it.effect(
    "(c) records the requested (declared) scopes when the authorization server omits scope",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tokenServer = yield* serveScopelessTokenServer();
          const plugins = [
            memoryCredentialsPlugin(),
            makeScopePlugin({ scopes: DECLARED_SCOPES }),
          ] as const;
          const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.acme.seed();

          // A client_credentials client so `start` mints inline (no redirect),
          // exchanging against the scopeless token endpoint.
          yield* executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: "http://127.0.0.1/authorize",
            tokenUrl: tokenServer.tokenEndpoint,
            grant: "client_credentials",
            clientId: "test-client",
            clientSecret: "test-secret",
          });

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("cc"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("connected");

          // The connection's recorded `oauth_scope` is the requested (declared) set
          // since the AS omitted `scope`.
          const row = yield* Effect.promise(() =>
            config.db.findFirst("connection", {
              where: (b) => b("name", "=", "cc"),
            }),
          );
          expect(row?.oauth_scope).toBe("calendar gmail drive sheets");
        }),
      ),
  );
});

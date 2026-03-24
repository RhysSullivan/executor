import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describe,
  expect,
  it,
} from "vitest";
import { createLocalExecutorEffect } from "@executor/platform-sdk-file/effect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  OpenApiConnectionAuthSchema,
  previewOpenApiDocument,
  type OpenApiOAuthSession,
  type OpenApiStoredSourceData,
} from "@executor/plugin-openapi-shared";

import {
  openApiSdkPlugin,
  type OpenApiOAuthSessionStorage,
  type OpenApiSourceStorage,
} from "./index";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const makeSourceStorage = (): OpenApiSourceStorage => {
  const entries = new Map<string, OpenApiStoredSourceData>();
  const key = (scopeId: string, sourceId: string) => `${scopeId}:${sourceId}`;

  return {
    get: ({ scopeId, sourceId }) =>
      Effect.succeed(entries.get(key(scopeId, sourceId)) ?? null),
    put: ({ scopeId, sourceId, value }) =>
      Effect.sync(() => {
        entries.set(key(scopeId, sourceId), value);
      }),
  };
};

const makeOAuthSessionStorage = (): OpenApiOAuthSessionStorage => {
  const entries = new Map<string, OpenApiOAuthSession>();

  return {
    get: (sessionId) => Effect.succeed(entries.get(sessionId) ?? null),
    put: ({ sessionId, value }) =>
      Effect.sync(() => {
        entries.set(sessionId, value);
      }),
    remove: (sessionId) =>
      Effect.sync(() => {
        entries.delete(sessionId);
      }),
  };
};

const withFetchMock = <A, E, R>(
  fetchImpl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = globalThis.fetch;
      globalThis.fetch = fetchImpl as typeof fetch;
      return original;
    }),
    () => effect,
    (original) =>
      Effect.sync(() => {
        globalThis.fetch = original;
      }),
  );

const makeExecutor = (
  input: {
    sourceStorage: OpenApiSourceStorage;
    oauthSessions: OpenApiOAuthSessionStorage;
  },
) => {
  const plugin = openApiSdkPlugin({
    storage: input.sourceStorage,
    oauthSessions: input.oauthSessions,
  });

  return Effect.acquireRelease(
    Effect.gen(function* () {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "executor-openapi-oauth-"));
      const homeConfigPath = join(workspaceRoot, ".executor-home.jsonc");
      const homeStateDirectory = join(workspaceRoot, ".executor-home-state");
      const executor = yield* createLocalExecutorEffect({
        localDataDir: ":memory:",
        workspaceRoot,
        homeConfigPath,
        homeStateDirectory,
        plugins: [plugin] as const,
      });

      return {
        executor,
        workspaceRoot,
      };
    }),
    ({ executor, workspaceRoot }) =>
      Effect.promise(() => executor.close())
        .pipe(
          Effect.zipRight(
            Effect.sync(() => {
              rmSync(workspaceRoot, {
                recursive: true,
                force: true,
              });
            }),
          ),
          Effect.orDie,
        ),
  );
};

describe("openapi-sdk oauth", () => {
  it("previews authorization code flows and decodes oauth2 auth config", async () => {
    await Effect.runPromise(withFetchMock(
      async () =>
        new Response(JSON.stringify({
          openapi: "3.1.0",
          info: {
            title: "OAuth Example",
            version: "1.0.0",
          },
          servers: [{ url: "https://api.example.com" }],
          paths: {},
          components: {
            securitySchemes: {
              oauthMain: {
                type: "oauth2",
                flows: {
                  authorizationCode: {
                    authorizationUrl: "https://auth.example.com/authorize",
                    tokenUrl: "https://auth.example.com/token",
                    scopes: {
                      read: "Read access",
                      write: "Write access",
                    },
                  },
                  clientCredentials: {
                    tokenUrl: "https://auth.example.com/token",
                    scopes: {
                      admin: "Admin access",
                    },
                  },
                },
              },
            },
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
      Effect.gen(function* () {
        const preview = yield* Effect.tryPromise({
          try: () => previewOpenApiDocument({
            specUrl: "https://example.com/openapi.json",
          }),
          catch: toError,
        });

        expect(preview.securitySchemes).toHaveLength(1);
        expect(preview.securitySchemes[0]).toMatchObject({
          name: "oauthMain",
          kind: "oauth2",
        });
        expect(preview.securitySchemes[0]?.oauthFlows).toEqual([
          {
            name: "authorizationCode",
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            refreshUrl: null,
            supported: true,
            scopes: [
              { name: "read", description: "Read access" },
              { name: "write", description: "Write access" },
            ],
          },
          {
            name: "clientCredentials",
            authorizationUrl: null,
            tokenUrl: "https://auth.example.com/token",
            refreshUrl: null,
            supported: false,
            scopes: [
              { name: "admin", description: "Admin access" },
            ],
          },
        ]);

        const decoded = Schema.decodeUnknownSync(OpenApiConnectionAuthSchema)({
          kind: "oauth2",
          schemeName: "oauthMain",
          flow: "authorizationCode",
          authorizationEndpoint: "https://auth.example.com/authorize",
          tokenEndpoint: "https://auth.example.com/token",
          scopes: ["read", "write"],
          clientId: "client-id",
          clientSecretRef: null,
          clientAuthentication: "none",
          accessTokenRef: "sec_access",
          refreshTokenRef: "sec_refresh",
          expiresAt: 1234,
        });

        expect(decoded.kind).toBe("oauth2");
        if (decoded.kind !== "oauth2") {
          throw new Error("Expected oauth2 auth config");
        }
        expect(decoded.scopes).toEqual(["read", "write"]);
      }),
    ));
  });

  it("starts and completes authorization code oauth with stored token metadata", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sourceStorage = makeSourceStorage();
      const oauthSessions = makeOAuthSessionStorage();
      const tokenRequests: string[] = [];
      const tokenAuthorizations: string[] = [];
      const { executor } = yield* makeExecutor({
        sourceStorage,
        oauthSessions,
      });

      const clientSecret = yield* executor.secrets.create({
        name: "OpenAPI OAuth Client Secret",
        value: "super-secret",
      });

      yield* withFetchMock(
        async (input, init) => {
          tokenRequests.push(String(input));
          const authorizationHeader =
            init?.headers instanceof Headers
              ? init.headers.get("authorization")
              : Array.isArray(init?.headers)
                ? (
                    init.headers.find(([key]) => key.toLowerCase() === "authorization")?.[1]
                    ?? null
                  )
                : init?.headers && typeof init.headers === "object"
                  ? (
                      (init.headers as Record<string, string | undefined>).authorization
                      ?? (init.headers as Record<string, string | undefined>).Authorization
                      ?? null
                    )
                  : null;
          tokenAuthorizations.push(authorizationHeader ?? "");
          const body = init?.body;
          const bodyText = body instanceof URLSearchParams ? body.toString() : String(body ?? "");
          tokenRequests.push(bodyText);

          return new Response(JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
          }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        },
        Effect.gen(function* () {
          const start = yield* executor.openapi.startOAuth({
            schemeName: "oauthMain",
            flow: "authorizationCode",
            authorizationEndpoint: "https://auth.example.com/authorize",
            tokenEndpoint: "https://auth.example.com/token",
            scopes: ["read", "write"],
            clientId: "client-id",
            clientSecretRef: clientSecret.id,
            redirectUrl: "http://127.0.0.1:63111/oauth/callback",
          });

          const authorizationUrl = new URL(start.authorizationUrl);
          expect(start.scopes).toEqual(["read", "write"]);
          expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
          expect(authorizationUrl.searchParams.get("client_id")).toBe("client-id");
          expect(authorizationUrl.searchParams.get("state")).toBe(start.sessionId);
          expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
          expect(authorizationUrl.searchParams.get("code_challenge")).not.toBeNull();

          const complete = yield* executor.openapi.completeOAuth({
            state: start.sessionId,
            code: "oauth-code",
          });

          expect(complete.auth.clientAuthentication).toBe("client_secret_basic");
          expect(complete.auth.clientSecretRef).toBe(clientSecret.id);
          expect(complete.auth.refreshTokenRef).not.toBeNull();
          expect(complete.auth.expiresAt).not.toBeNull();
          expect(complete.auth.accessTokenRef).not.toBe(complete.auth.refreshTokenRef);
          expect(yield* oauthSessions.get(start.sessionId)).toBeNull();

          const secrets = yield* executor.secrets.list();
          const accessToken = secrets.find((secret: { id: string }) =>
            secret.id === complete.auth.accessTokenRef
          );
          const refreshToken = secrets.find((secret: { id: string }) =>
            secret.id === complete.auth.refreshTokenRef
          );

          expect(accessToken?.purpose).toBe("oauth_access_token");
          expect(accessToken?.expiresAt).not.toBeNull();
          expect(refreshToken?.purpose).toBe("oauth_refresh_token");
          expect(refreshToken?.expiresAt).toBeNull();
        }),
      );

      expect(tokenRequests[0]).toBe("https://auth.example.com/token");
      const tokenBody = new URLSearchParams(tokenRequests[1]);
      expect(tokenBody.get("grant_type")).toBe("authorization_code");
      expect(tokenBody.get("client_id")).toBeNull();
      expect(tokenBody.get("client_secret")).toBeNull();
      expect(tokenBody.get("code")).toBe("oauth-code");
      expect(tokenBody.get("code_verifier")).toBeTruthy();
      expect(tokenAuthorizations[0]).toBe(
        `Basic ${Buffer.from("client-id:super-secret", "utf8").toString("base64")}`,
      );
    })));
  });

  it("fails oauth completion when the provider does not return a refresh token", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { executor } = yield* makeExecutor({
        sourceStorage: makeSourceStorage(),
        oauthSessions: makeOAuthSessionStorage(),
      });

      yield* withFetchMock(
        async () =>
          new Response(JSON.stringify({
            access_token: "access-token",
            expires_in: 3600,
          }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
        Effect.gen(function* () {
          const start = yield* executor.openapi.startOAuth({
            schemeName: "oauthMain",
            flow: "authorizationCode",
            authorizationEndpoint: "https://auth.example.com/authorize",
            tokenEndpoint: "https://auth.example.com/token",
            scopes: ["read"],
            clientId: "client-id",
            clientSecretRef: null,
            redirectUrl: "http://127.0.0.1:63111/oauth/callback",
          });

          const failure: Error = yield* Effect.flip(
            executor.openapi.completeOAuth({
              state: start.sessionId,
              code: "oauth-code",
            }),
          );

          expect(failure.message).toContain("did not return a refresh token");
        }),
      );
    })));
  });

  it("retries spec fetch without oauth auth when an authenticated public spec request is rejected", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { executor } = yield* makeExecutor({
        sourceStorage: makeSourceStorage(),
        oauthSessions: makeOAuthSessionStorage(),
      });
      const accessToken = yield* executor.secrets.create({
        name: "OpenAPI OAuth Access Token",
        value: "access-token",
        purpose: "oauth_access_token",
      });
      const refreshToken = yield* executor.secrets.create({
        name: "OpenAPI OAuth Refresh Token",
        value: "refresh-token",
        purpose: "oauth_refresh_token",
      });
      const requests: Array<{
        authorization: string | null;
      }> = [];

      yield* withFetchMock(
        async (_input, init) => {
          const authorizationHeader =
            init?.headers instanceof Headers
              ? init.headers.get("authorization")
              : Array.isArray(init?.headers)
                ? (
                    init.headers.find(([key]) => key.toLowerCase() === "authorization")?.[1]
                    ?? null
                  )
                : init?.headers && typeof init.headers === "object"
                  ? (
                      (init.headers as Record<string, string | undefined>).authorization
                      ?? (init.headers as Record<string, string | undefined>).Authorization
                      ?? null
                    )
                  : null;

          requests.push({
            authorization: authorizationHeader,
          });

          if (authorizationHeader) {
            return new Response("forbidden", {
              status: 403,
              headers: {
                "content-type": "text/plain",
              },
            });
          }

          return new Response(JSON.stringify({
            openapi: "3.1.0",
            info: {
              title: "OAuth Example",
              version: "1.0.0",
            },
            servers: [{ url: "https://api.example.com" }],
            paths: {},
            components: {
              securitySchemes: {
                oauthMain: {
                  type: "oauth2",
                  flows: {
                    authorizationCode: {
                      authorizationUrl: "https://auth.example.com/authorize",
                      tokenUrl: "https://auth.example.com/token",
                      scopes: {
                        read: "Read access",
                      },
                    },
                  },
                },
              },
            },
          }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        },
        Effect.gen(function* () {
          const source = yield* executor.openapi.createSource({
            name: "OAuth-backed public spec",
            specUrl: "https://example.com/openapi.json",
            baseUrl: "https://api.example.com",
            auth: {
              kind: "oauth2",
              schemeName: "oauthMain",
              flow: "authorizationCode",
              authorizationEndpoint: "https://auth.example.com/authorize",
              tokenEndpoint: "https://auth.example.com/token",
              scopes: ["read"],
              clientId: "client-id",
              clientSecretRef: null,
              clientAuthentication: "none",
              accessTokenRef: accessToken.id,
              refreshTokenRef: refreshToken.id,
              expiresAt: Date.now() + 3_600_000,
            },
          });

          expect(source.kind).toBe("openapi");
        }),
      );

      expect(requests).toEqual([
        {
          authorization: "Bearer access-token",
        },
        {
          authorization: null,
        },
      ]);
    })));
  });
});

import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  AccountIdSchema,
  McpSourceAuthSessionDataJsonSchema,
  OAuth2PkceSourceAuthSessionDataJsonSchema,
  SecretMaterialIdSchema,
  type Source,
  type SourceAuthSession,
  WorkspaceIdSchema,
  decodeAuthLeasePlacementTemplates,
  decodeBuiltInAuthArtifactConfig,
} from "#schema";
import {
  createSqlControlPlanePersistence,
  type SqlControlPlanePersistence,
} from "#persistence";

import {
  createRuntimeSourceAuthService,
  createTerminalSourceAuthSessionPatch,
} from "./source-auth-service";
import { createLiveExecutionManager } from "./live-execution";
import { createDefaultSecretMaterialResolver } from "./secret-material-providers";
import { resolveSourceAuthMaterial } from "./source-auth-material";

const makeExistingOpenApiSource = (auth: Source["auth"]): Source => ({
  id: "src_test" as Source["id"],
  workspaceId: "ws_test" as Source["workspaceId"],
  name: "GitHub",
  kind: "openapi",
  endpoint: "https://api.github.com",
  status: "connected",
  enabled: true,
  namespace: "github",
  bindingVersion: 1,
  binding: {
    specUrl: "https://example.com/openapi.json",
    defaultHeaders: null,
  },
  importAuthPolicy: "reuse_runtime",
  importAuth: { kind: "none" },
  auth,
  sourceHash: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});

const fetchLiveDiscoveryDocument = async (): Promise<string> => {
  const response = await fetch("https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest", {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Sheets discovery doc: ${response.status}`);
  }

  return response.text();
};

const withGoogleAuthTestServer = async <T>(input: {
  discoveryDocument: string;
  handler: (server: {
    discoveryUrl: string;
    tokenUrl: string;
    tokenRequests: Array<URLSearchParams>;
  }) => Promise<T>;
}): Promise<T> => {
  const tokenRequests: Array<URLSearchParams> = [];
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    );

    if (request.method === "GET" && requestUrl.pathname === "/discovery") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(input.discoveryDocument);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      tokenRequests.push(form);

      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      if (form.get("grant_type") === "authorization_code") {
        response.end(
          JSON.stringify({
            access_token: "access-token-initial",
            refresh_token: "refresh-token-live",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
            token_type: "Bearer",
          }),
        );
        return;
      }

      response.end(
        JSON.stringify({
          access_token: "access-token-refreshed",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve Google auth test server address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return await input.handler({
      discoveryUrl: `${baseUrl}/discovery`,
      tokenUrl: `${baseUrl}/token`,
      tokenRequests,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
};

const makePersistence = async (): Promise<SqlControlPlanePersistence> =>
  Effect.runPromise(
    createSqlControlPlanePersistence({
      localDataDir: ":memory:",
    }),
  );

describe("source-auth-service", () => {
  const encodeSessionDataJson = Schema.encodeSync(McpSourceAuthSessionDataJsonSchema);

  const baseSessionDataJson = encodeSessionDataJson({
    kind: "mcp_oauth",
    endpoint: "https://example.com/resource",
    redirectUri: "http://127.0.0.1/callback",
    scope: null,
    resourceMetadataUrl: "https://example.com/resource",
    authorizationServerUrl: "https://example.com/as",
    resourceMetadata: {
      issuer: "https://example.com",
    },
    authorizationServerMetadata: {
      token_endpoint: "https://example.com/token",
    },
    clientInformation: {
      client_id: "abc",
    },
    codeVerifier: "verifier",
    authorizationUrl: "https://example.com/auth",
  });

  it("clears ephemeral OAuth session fields when failing a session", () => {
    const patch = createTerminalSourceAuthSessionPatch({
      sessionDataJson: baseSessionDataJson,
      status: "failed",
      now: 123,
      errorText: "OAuth authorization failed",
    });

    expect(patch).toMatchObject({
      sessionDataJson: baseSessionDataJson,
      status: "failed",
      errorText: "OAuth authorization failed",
      completedAt: 123,
      updatedAt: 123,
    });
  });

  it("clears ephemeral OAuth session fields when completing a session", () => {
    const patch = createTerminalSourceAuthSessionPatch({
      sessionDataJson: baseSessionDataJson,
      status: "completed",
      now: 456,
      errorText: null,
    });

    expect(patch).toMatchObject({
      sessionDataJson: baseSessionDataJson,
      status: "completed",
      errorText: null,
      completedAt: 456,
      updatedAt: 456,
    });
  });

  it("completes Google Discovery desktop OAuth into a refreshable auth artifact and lease", async () => {
    const discoveryDocument = await fetchLiveDiscoveryDocument();

    const persistence = await makePersistence();
    try {
      const now = Date.now();
      const workspaceId = WorkspaceIdSchema.make("ws_google_oauth");
      const accountId = AccountIdSchema.make("acc_google_oauth");

      await Effect.runPromise(
        persistence.rows.organizations.insert({
          id: "org_google_oauth" as any,
          slug: "google-oauth",
          name: "Google OAuth",
          status: "active",
          createdByAccountId: accountId,
          createdAt: now,
          updatedAt: now,
        }),
      );
      await Effect.runPromise(
        persistence.rows.workspaces.insert({
          id: workspaceId,
          organizationId: "org_google_oauth" as any,
          name: "Workspace",
          createdByAccountId: accountId,
          createdAt: now,
          updatedAt: now,
        }),
      );

      const service = createRuntimeSourceAuthService({
        rows: persistence.rows,
        liveExecutionManager: createLiveExecutionManager(),
        getLocalServerBaseUrl: () => "http://localhost:8788",
      });

      await withGoogleAuthTestServer({
        discoveryDocument,
        handler: async ({ discoveryUrl, tokenUrl, tokenRequests }) => {
          const originalFetch = globalThis.fetch;
          globalThis.fetch = (async (input, init) => {
            const url = typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
            if (url === "https://oauth2.googleapis.com/token") {
              return originalFetch(tokenUrl, init);
            }

            return originalFetch(input as any, init);
          }) as typeof fetch;

          try {
            const addResult = await Effect.runPromise(
              service.addExecutorSource({
                kind: "google_discovery",
                workspaceId,
                actorAccountId: accountId,
                executionId: null,
                interactionId: null,
                service: "sheets",
                version: "v4",
                discoveryUrl,
                scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
                oauthClient: {
                  clientId: "google-test-client",
                  clientSecret: "google-test-secret",
                },
              }),
            );

            expect(addResult.kind).toBe("oauth_required");
            if (addResult.kind !== "oauth_required") {
              return;
            }

            const sessionOption = await Effect.runPromise(
              persistence.rows.sourceAuthSessions.getById(addResult.sessionId),
            );
            expect(Option.isSome(sessionOption)).toBe(true);
            const session = Option.getOrNull(sessionOption) as SourceAuthSession;
            const oauthClientOption = await Effect.runPromise(
              persistence.rows.sourceOauthClients.getByWorkspaceSourceAndProvider({
                workspaceId,
                sourceId: addResult.source.id,
                providerKey: "google_workspace",
              }),
            );
            expect(Option.isSome(oauthClientOption)).toBe(true);
            const oauthClient = Option.getOrNull(oauthClientOption)!;
            expect(oauthClient.clientId).toBe("google-test-client");
            expect(oauthClient.clientSecretProviderId).toBe("postgres");
            expect(oauthClient.clientSecretHandle).toBeTruthy();
            expect(session.providerKind).toBe("oauth2_pkce");
            const sessionData = Schema.decodeUnknownSync(
              OAuth2PkceSourceAuthSessionDataJsonSchema,
            )(session.sessionDataJson);
            expect(sessionData.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
            expect(sessionData.tokenEndpoint).toBe("https://oauth2.googleapis.com/token");
            expect(sessionData.authorizationUrl).toContain(
              encodeURIComponent(sessionData.redirectUri),
            );

            const loopbackResponse = await fetch(
              `${sessionData.redirectUri}/?state=${encodeURIComponent(session.state)}&code=loopback-code`,
              {
                redirect: "manual",
              },
            );
            expect(loopbackResponse.status).toBe(302);
            const completionLocation = loopbackResponse.headers.get("location");
            expect(completionLocation).toBeTruthy();
            if (!completionLocation) {
              return;
            }
            const completionUrl = new URL(completionLocation);
            expect(completionUrl.origin).toBe("http://localhost:8788");
            expect(completionUrl.searchParams.get("state")).toBe(session.state);
            expect(completionUrl.searchParams.get("code")).toBe("loopback-code");

            const connectedSource = await Effect.runPromise(
              service.completeSourceCredentialSetup({
                workspaceId,
                sourceId: addResult.source.id,
                actorAccountId: accountId,
                state: session.state,
                code: "authorization-code",
              }),
            );

            expect(connectedSource.status).toBe("connected");
            expect(connectedSource.auth.kind).toBe("oauth2_authorized_user");
            if (connectedSource.auth.kind !== "oauth2_authorized_user") {
              return;
            }
            expect(connectedSource.auth.clientId).toBe("google-test-client");
            expect(connectedSource.auth.tokenEndpoint).toBe("https://oauth2.googleapis.com/token");
            expect(connectedSource.auth.grantSet).toEqual([
              "https://www.googleapis.com/auth/spreadsheets.readonly",
            ]);

            expect(tokenRequests).toHaveLength(1);
            expect(tokenRequests[0]?.get("grant_type")).toBe("authorization_code");
            expect(tokenRequests[0]?.get("client_id")).toBe("google-test-client");
            expect(tokenRequests[0]?.get("client_secret")).toBe("google-test-secret");
            expect(tokenRequests[0]?.get("code")).toBe("authorization-code");
            expect(tokenRequests[0]?.get("redirect_uri")).toBe(sessionData.redirectUri);
            expect(tokenRequests[0]?.get("code_verifier")).toBe(sessionData.codeVerifier);

            const artifactOption = await Effect.runPromise(
              persistence.rows.authArtifacts.getByWorkspaceSourceAndActor({
                workspaceId,
                sourceId: connectedSource.id,
                actorAccountId: accountId,
                slot: "runtime",
              }),
            );
            expect(Option.isSome(artifactOption)).toBe(true);
            const artifact = Option.getOrNull(artifactOption)!;
            const decodedArtifact = decodeBuiltInAuthArtifactConfig(artifact);
            expect(decodedArtifact?.artifactKind).toBe("oauth2_authorized_user");

            const leaseOption = await Effect.runPromise(
              persistence.rows.authLeases.getByAuthArtifactId(artifact.id),
            );
            expect(Option.isSome(leaseOption)).toBe(true);
            const initialLease = Option.getOrNull(leaseOption)!;
            const initialTemplates = decodeAuthLeasePlacementTemplates(initialLease);
            expect(initialTemplates).toEqual([
              {
                location: "header",
                name: "Authorization",
                parts: [
                  {
                    kind: "literal",
                    value: "Bearer ",
                  },
                  {
                    kind: "secret_ref",
                    ref: {
                      providerId: "postgres",
                      handle: expect.any(String),
                    },
                  },
                ],
              },
            ]);

            const resolver = createDefaultSecretMaterialResolver({
              rows: persistence.rows,
            });
            const resolvedInitialAuth = await Effect.runPromise(
              resolveSourceAuthMaterial({
                source: connectedSource,
                slot: "runtime",
                actorAccountId: accountId,
                rows: persistence.rows,
                resolveSecretMaterial: resolver,
              }),
            );
            expect(resolvedInitialAuth.headers.Authorization).toBe(
              "Bearer access-token-initial",
            );

            await Effect.runPromise(
              persistence.rows.authLeases.upsert({
                ...initialLease,
                refreshAfter: Date.now() - 1,
                expiresAt: Date.now() + 10_000,
                updatedAt: Date.now(),
              }),
            );

            const previousAccessTokenHandle = initialTemplates?.[0]?.parts[1];
            const refreshedAuth = await Effect.runPromise(
              resolveSourceAuthMaterial({
                source: connectedSource,
                slot: "runtime",
                actorAccountId: accountId,
                rows: persistence.rows,
                resolveSecretMaterial: resolver,
              }),
            );
            expect(refreshedAuth.headers.Authorization).toBe(
              "Bearer access-token-refreshed",
            );
            expect(tokenRequests).toHaveLength(2);
            expect(tokenRequests[1]?.get("grant_type")).toBe("refresh_token");
            expect(tokenRequests[1]?.get("refresh_token")).toBe("refresh-token-live");

            if (previousAccessTokenHandle?.kind === "secret_ref") {
              const oldSecret = await Effect.runPromise(
                persistence.rows.secretMaterials.getById(
                  SecretMaterialIdSchema.make(previousAccessTokenHandle.ref.handle),
                ),
              );
              expect(Option.isNone(oldSecret)).toBe(true);
            }

            const recipeOperations = await Effect.runPromise(
              persistence.rows.sources.getByWorkspaceAndId(
                workspaceId,
                connectedSource.id,
              ),
            );
            expect(Option.isSome(recipeOperations)).toBe(true);
            const storedSource = Option.getOrNull(recipeOperations)!;
            const materializedOperations = await Effect.runPromise(
              persistence.rows.sourceRecipeOperations.listByRevisionId(
                storedSource.recipeRevisionId,
              ),
            );
            expect(materializedOperations.length).toBeGreaterThan(0);
            expect(
              materializedOperations.some(
                (operation) => operation.toolId === "spreadsheets.values.get",
              ),
            ).toBe(true);
          } finally {
            globalThis.fetch = originalFetch;
          }
        },
      });
    } finally {
      await persistence.close();
    }
  }, 60_000);

  it("uses the request origin callback for Google Discovery OAuth started from the web app", async () => {
    const discoveryDocument = await fetchLiveDiscoveryDocument();

    const persistence = await makePersistence();
    try {
      const now = Date.now();
      const workspaceId = WorkspaceIdSchema.make("ws_google_oauth_web");
      const accountId = AccountIdSchema.make("acc_google_oauth_web");

      await Effect.runPromise(
        persistence.rows.organizations.insert({
          id: "org_google_oauth_web" as any,
          slug: "google-oauth-web",
          name: "Google OAuth Web",
          status: "active",
          createdByAccountId: accountId,
          createdAt: now,
          updatedAt: now,
        }),
      );
      await Effect.runPromise(
        persistence.rows.workspaces.insert({
          id: workspaceId,
          organizationId: "org_google_oauth_web" as any,
          name: "Workspace",
          createdByAccountId: accountId,
          createdAt: now,
          updatedAt: now,
        }),
      );

      const service = createRuntimeSourceAuthService({
        rows: persistence.rows,
        liveExecutionManager: createLiveExecutionManager(),
        getLocalServerBaseUrl: () => "http://127.0.0.1:8788",
      });

      await withGoogleAuthTestServer({
        discoveryDocument,
        handler: async ({ discoveryUrl, tokenUrl }) => {
          const originalFetch = globalThis.fetch;
          globalThis.fetch = (async (input, init) => {
            const url = typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
            if (url === "https://oauth2.googleapis.com/token") {
              return originalFetch(tokenUrl, init);
            }

            return originalFetch(input as any, init);
          }) as typeof fetch;

          try {
            const addResult = await Effect.runPromise(
              service.addExecutorSource(
                {
                  kind: "google_discovery",
                  workspaceId,
                  actorAccountId: accountId,
                  executionId: null,
                  interactionId: null,
                  service: "sheets",
                  version: "v4",
                  discoveryUrl,
                  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
                  oauthClient: {
                    clientId: "google-test-client",
                    clientSecret: "google-test-secret",
                  },
                },
                {
                  baseUrl: "https://app.executor.dev",
                },
              ),
            );

            expect(addResult.kind).toBe("oauth_required");
            if (addResult.kind !== "oauth_required") {
              return;
            }

            const sessionOption = await Effect.runPromise(
              persistence.rows.sourceAuthSessions.getById(addResult.sessionId),
            );
            expect(Option.isSome(sessionOption)).toBe(true);
            const session = Option.getOrNull(sessionOption) as SourceAuthSession;
            const sessionData = Schema.decodeUnknownSync(
              OAuth2PkceSourceAuthSessionDataJsonSchema,
            )(session.sessionDataJson);

            expect(sessionData.redirectUri).toBe(
              `https://app.executor.dev/v1/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(addResult.source.id)}/credentials/oauth/complete`,
            );
            expect(sessionData.authorizationUrl).toContain(
              encodeURIComponent(sessionData.redirectUri),
            );
            expect(sessionData.redirectUri).not.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
          } finally {
            globalThis.fetch = originalFetch;
          }
        },
      });
    } finally {
      await persistence.close();
    }
  }, 60_000);
});

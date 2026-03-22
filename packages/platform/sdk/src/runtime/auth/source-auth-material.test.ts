import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  AuthArtifactIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
  type Source,
} from "#schema";

import { resolveSourceAuthMaterialWithDeps } from "./source-auth-material";

const makeSource = (overrides: Partial<Source> = {}): Source => ({
  id: SourceIdSchema.make("src_tool_artifacts"),
  workspaceId: WorkspaceIdSchema.make("ws_tool_artifacts"),
  name: "GitHub",
  kind: "openapi",
  endpoint: "https://api.github.com",
  status: "connected",
  enabled: true,
  namespace: "github",
  bindingVersion: 1,
  binding: {
    specUrl: "https://api.github.com/openapi.json",
    defaultHeaders: null,
  },
  importAuthPolicy: "reuse_runtime",
  importAuth: { kind: "none" },
  auth: { kind: "none" },
  sourceHash: null,
  lastError: null,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

describe("source-auth-material", () => {
  describe("resolveSourceAuthMaterial", () => {
    it.effect("returns empty headers for auth.kind none", () =>
      Effect.gen(function* () {
        const auth = yield* resolveSourceAuthMaterialWithDeps({
          source: makeSource({
            auth: { kind: "none" },
          }),
          resolveSecretMaterial: () => Effect.die("should not be called"),
        });

        expect(auth).toEqual({
          placements: [],
          headers: {},
          queryParams: {},
          cookies: {},
          bodyValues: {},
          expiresAt: null,
          refreshAfter: null,
        });
      }),
    );

    it.effect(
      "resolves bearer auth headers from the configured token ref",
      () => {
        const calls: string[] = [];

        return Effect.gen(function* () {
          const auth = yield* resolveSourceAuthMaterialWithDeps({
            source: makeSource({
              auth: {
                kind: "bearer",
                headerName: "X-Api-Key",
                prefix: "Token ",
                token: {
                  providerId: "local",
                  handle: "sec_bearer",
                },
              },
            }),
            resolveSecretMaterial: ({ ref }) => {
              calls.push(`${ref.providerId}:${ref.handle}`);
              return Effect.succeed("resolved-bearer-token");
            },
          });

          expect(calls).toEqual(["local:sec_bearer"]);
          expect(auth).toEqual({
            placements: [
              {
                location: "header",
                name: "X-Api-Key",
                value: "Token resolved-bearer-token",
              },
            ],
            headers: {
              "X-Api-Key": "Token resolved-bearer-token",
            },
            queryParams: {},
            cookies: {},
            bodyValues: {},
            expiresAt: null,
            refreshAfter: null,
          });
        });
      },
    );

    it.effect(
      "uses the oauth access token ref and ignores the refresh token",
      () => {
        const calls: string[] = [];

        return Effect.gen(function* () {
          const auth = yield* resolveSourceAuthMaterialWithDeps({
            source: makeSource({
              kind: "graphql",
              endpoint: "https://example.com/graphql",
              binding: {
                defaultHeaders: null,
              },
              auth: {
                kind: "oauth2",
                headerName: "Authorization",
                prefix: "Bearer ",
                accessToken: {
                  providerId: "local",
                  handle: "sec_access",
                },
                refreshToken: {
                  providerId: "local",
                  handle: "sec_refresh",
                },
              },
            }),
            resolveSecretMaterial: ({ ref }) => {
              calls.push(`${ref.providerId}:${ref.handle}`);
              return Effect.succeed("resolved-access-token");
            },
          });

          expect(calls).toEqual(["local:sec_access"]);
          expect(auth).toEqual({
            placements: [
              {
                location: "header",
                name: "Authorization",
                value: "Bearer resolved-access-token",
              },
            ],
            headers: {
              Authorization: "Bearer resolved-access-token",
            },
            queryParams: {},
            cookies: {},
            bodyValues: {},
            expiresAt: null,
            refreshAfter: null,
          });
        });
      },
    );

    it.effect(
      "reconstructs persisted MCP OAuth auth providers from stored auth artifacts",
      () => {
        const calls: string[] = [];

        return Effect.gen(function* () {
          const auth = yield* resolveSourceAuthMaterialWithDeps({
            source: makeSource({
              kind: "mcp",
              endpoint: "https://example.com/mcp",
              binding: {
                transport: "streamable-http",
                queryParams: null,
                headers: null,
              },
              auth: { kind: "none" },
            }),
            actorAccountId: null,
            executorState: {
              authArtifacts: {
                getByWorkspaceSourceAndActor: () =>
                  Effect.succeed(
                    Option.some({
                      id: AuthArtifactIdSchema.make("auth_artifact_mcp"),
                      workspaceId: WorkspaceIdSchema.make("ws_tool_artifacts"),
                      sourceId: SourceIdSchema.make("src_tool_artifacts"),
                      actorAccountId: null,
                      slot: "runtime",
                      artifactKind: "mcp_oauth",
                      configJson: JSON.stringify({
                        redirectUri: "http://127.0.0.1/oauth/callback",
                        accessToken: {
                          providerId: "local",
                          handle: "sec_mcp_access",
                        },
                        refreshToken: {
                          providerId: "local",
                          handle: "sec_mcp_refresh",
                        },
                        tokenType: "Bearer",
                        expiresIn: 3600,
                        scope: "mcp",
                        resourceMetadataUrl:
                          "https://example.com/.well-known/oauth-protected-resource",
                        authorizationServerUrl: "https://example.com/oauth",
                        resourceMetadataJson: JSON.stringify({
                          resource: "mcp",
                        }),
                        authorizationServerMetadataJson: JSON.stringify({
                          issuer: "https://example.com/oauth",
                          token_endpoint: "https://example.com/oauth/token",
                        }),
                        clientInformationJson: JSON.stringify({
                          client_id: "client-123",
                        }),
                      }),
                      grantSetJson: null,
                      createdAt: 1,
                      updatedAt: 1,
                    }),
                  ),
              },
              authLeases: {
                getByAuthArtifactId: () => Effect.succeed(Option.none()),
              },
            } as any,
            resolveSecretMaterial: ({ ref }) => {
              calls.push(`${ref.providerId}:${ref.handle}`);
              return Effect.succeed(
                ref.handle === "sec_mcp_access"
                  ? "persisted-access-token"
                  : "persisted-refresh-token",
              );
            },
          });

          expect(auth.headers).toEqual({});
          expect(auth.authProvider).toBeDefined();

          const tokens = yield* Effect.tryPromise({
            try: () => auth.authProvider!.tokens(),
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
          });

          expect(tokens).toEqual({
            access_token: "persisted-access-token",
            refresh_token: "persisted-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "mcp",
          });
          expect(calls).toEqual([
            "local:sec_mcp_access",
            "local:sec_mcp_refresh",
          ]);
        });
      },
    );
  });
});

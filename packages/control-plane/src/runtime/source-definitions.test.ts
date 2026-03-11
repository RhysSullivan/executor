import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import {
  CredentialIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
  type Source,
} from "#schema";

import {
  createSourceFromPayload,
  projectSourceFromStorage,
  splitSourceForStorage,
  stableSourceRecipeId,
  stableSourceRecipeRevisionId,
  updateSourceFromPayload,
} from "./source-definitions";
import { namespaceFromSourceName } from "./source-names";

const openApiBinding = (
  specUrl = "https://api.github.com/openapi.json",
  defaultHeaders: Record<string, string> | null = null,
) => ({
  specUrl,
  defaultHeaders,
});

const graphqlBinding = (defaultHeaders: Record<string, string> | null = null) => ({
  defaultHeaders,
});

const mcpBinding = (input: {
  transport?: "auto" | "streamable-http" | "sse" | null;
  queryParams?: Record<string, string> | null;
  headers?: Record<string, string> | null;
} = {}) => ({
  transport: input.transport ?? null,
  queryParams: input.queryParams ?? null,
  headers: input.headers ?? null,
});

const makeSource = (overrides: Partial<Source> = {}): Source => ({
  id: SourceIdSchema.make("src_source_definitions"),
  workspaceId: WorkspaceIdSchema.make("ws_source_definitions"),
  name: "GitHub",
  kind: "openapi",
  endpoint: "https://api.github.com",
  status: "connected",
  enabled: true,
  namespace: "github",
  bindingVersion: 1,
  binding: openApiBinding(),
  importAuthPolicy: "reuse_runtime",
  importAuth: { kind: "none" },
  auth: { kind: "none" },
  sourceHash: null,
  lastError: null,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

describe("source-definitions", () => {
  describe("stable recipe ids", () => {
    it("is deterministic across calls and ignores source name/workspace", () => {
      const source = makeSource();
      const renamed = makeSource({
        name: "Renamed GitHub",
      });
      const differentWorkspace = makeSource({
        workspaceId: WorkspaceIdSchema.make("ws_source_definitions_other"),
      });

      expect(stableSourceRecipeId(source)).toBe(stableSourceRecipeId(source));
      expect(stableSourceRecipeRevisionId(source)).toBe(stableSourceRecipeRevisionId(source));
      expect(stableSourceRecipeId(renamed)).toBe(stableSourceRecipeId(source));
      expect(stableSourceRecipeRevisionId(renamed)).toBe(stableSourceRecipeRevisionId(source));
      expect(stableSourceRecipeId(differentWorkspace)).toBe(stableSourceRecipeId(source));
      expect(stableSourceRecipeRevisionId(differentWorkspace)).toBe(
        stableSourceRecipeRevisionId(source),
      );
    });

    it("changes recipe and revision ids when the source config changes", () => {
      const source = makeSource();
      const changedEndpoint = makeSource({
        endpoint: "https://example.com",
        binding: openApiBinding("https://example.com/openapi.json"),
      });

      expect(stableSourceRecipeId(changedEndpoint)).not.toBe(stableSourceRecipeId(source));
      expect(stableSourceRecipeRevisionId(changedEndpoint)).not.toBe(
        stableSourceRecipeRevisionId(source),
      );
    });
  });

  describe("payload normalization and validation", () => {
    it("defaults created sources to draft/enabled and trims fields", async () => {
      const source = await Effect.runPromise(createSourceFromPayload({
        workspaceId: WorkspaceIdSchema.make("ws_create_defaults"),
        sourceId: SourceIdSchema.make("src_create_defaults"),
        payload: {
          name: "  GitHub  ",
          kind: "openapi",
          endpoint: " https://api.github.com ",
          binding: openApiBinding(" https://api.github.com/openapi.json "),
        },
        now: 1234,
      }));

      expect(source.name).toBe("GitHub");
      expect(source.endpoint).toBe("https://api.github.com");
      expect(source.binding).toEqual(openApiBinding("https://api.github.com/openapi.json"));
      expect(source.status).toBe("draft");
      expect(source.enabled).toBe(true);
      expect(source.auth).toEqual({ kind: "none" });
    });

    it("preserves existing values on partial update and keeps auth when undefined", async () => {
      const source = makeSource({
        kind: "graphql",
        endpoint: "https://example.com/graphql",
        binding: graphqlBinding({ accept: "application/json" }),
        auth: {
          kind: "bearer",
          headerName: "Authorization",
          prefix: "Bearer ",
          token: {
            providerId: "postgres",
            handle: "sec_token",
          },
        },
      });

      const updated = await Effect.runPromise(updateSourceFromPayload({
        source,
        payload: {
          status: "error",
          lastError: "bad gateway",
        },
        now: 2000,
      }));

      expect(updated.name).toBe(source.name);
      expect(updated.endpoint).toBe(source.endpoint);
      expect(updated.binding).toEqual(source.binding);
      expect(updated.auth).toEqual(source.auth);
      expect(updated.status).toBe("error");
      expect(updated.lastError).toBe("bad gateway");
      expect(updated.updatedAt).toBe(2000);
    });

    it("normalizes oauth2 auth defaults and allows null refresh tokens", async () => {
      const source = await Effect.runPromise(createSourceFromPayload({
        workspaceId: WorkspaceIdSchema.make("ws_create_oauth_defaults"),
        sourceId: SourceIdSchema.make("src_create_oauth_defaults"),
        payload: {
          name: "GraphQL Demo",
          kind: "graphql",
          endpoint: "https://example.com/graphql",
          auth: {
            kind: "oauth2",
            headerName: "   ",
            prefix: undefined,
            accessToken: {
              providerId: " postgres ",
              handle: " sec_access ",
            },
            refreshToken: null,
          } as never,
        },
        now: 1234,
      }));

      expect(source.auth).toEqual({
        kind: "oauth2",
        headerName: "Authorization",
        prefix: "Bearer ",
        accessToken: {
          providerId: "postgres",
          handle: "sec_access",
        },
        refreshToken: null,
      });
    });

    it("rejects invalid bearer and oauth2 secret refs", async () => {
      await expect(Effect.runPromise(createSourceFromPayload({
        workspaceId: WorkspaceIdSchema.make("ws_invalid_bearer"),
        sourceId: SourceIdSchema.make("src_invalid_bearer"),
        payload: {
          name: "Bad Bearer",
          kind: "openapi",
          endpoint: "https://example.com",
          binding: openApiBinding("https://example.com/openapi.json"),
          auth: {
            kind: "bearer",
            headerName: "Authorization",
            prefix: "Bearer ",
            token: {
              providerId: "   ",
              handle: "sec_token",
            },
          },
        },
        now: 1234,
      }))).rejects.toThrow("Bearer auth requires a token secret ref");

      await expect(Effect.runPromise(createSourceFromPayload({
        workspaceId: WorkspaceIdSchema.make("ws_invalid_refresh"),
        sourceId: SourceIdSchema.make("src_invalid_refresh"),
        payload: {
          name: "Bad OAuth",
          kind: "graphql",
          endpoint: "https://example.com/graphql",
          binding: graphqlBinding(),
          auth: {
            kind: "oauth2",
            headerName: "Authorization",
            prefix: "Bearer ",
            accessToken: {
              providerId: "postgres",
              handle: "sec_access",
            },
            refreshToken: {
              providerId: "postgres",
              handle: "   ",
            },
          } as never,
        },
        now: 1234,
      }))).rejects.toThrow("OAuth2 refresh token ref must include providerId and handle");
    });

    it("rejects invalid source kind combinations", async () => {
      await expect(Effect.runPromise(createSourceFromPayload({
        workspaceId: WorkspaceIdSchema.make("ws_invalid_mcp"),
        sourceId: SourceIdSchema.make("src_invalid_mcp"),
        payload: {
          name: "MCP",
          kind: "mcp",
          endpoint: "https://example.com/mcp",
          binding: {
            specUrl: "https://example.com/openapi.json",
          },
        } as never,
        now: 1234,
      }))).rejects.toThrow("MCP sources cannot define specUrl");

      await expect(Effect.runPromise(createSourceFromPayload({
        workspaceId: WorkspaceIdSchema.make("ws_invalid_openapi_spec"),
        sourceId: SourceIdSchema.make("src_invalid_openapi_spec"),
        payload: {
          name: "OpenAPI",
          kind: "openapi",
          endpoint: "https://example.com",
          binding: openApiBinding("   "),
        } as never,
        now: 1234,
      }))).rejects.toThrow("OpenAPI sources require specUrl");

      await expect(Effect.runPromise(createSourceFromPayload({
        workspaceId: WorkspaceIdSchema.make("ws_invalid_openapi_transport"),
        sourceId: SourceIdSchema.make("src_invalid_openapi_transport"),
        payload: {
          name: "OpenAPI",
          kind: "openapi",
          endpoint: "https://example.com",
          binding: {
            specUrl: "https://example.com/openapi.json",
            transport: "sse",
          },
        } as never,
        now: 1234,
      }))).rejects.toThrow("OpenAPI sources cannot define MCP transport settings");

      await expect(Effect.runPromise(createSourceFromPayload({
        workspaceId: WorkspaceIdSchema.make("ws_invalid_graphql"),
        sourceId: SourceIdSchema.make("src_invalid_graphql"),
        payload: {
          name: "GraphQL",
          kind: "graphql",
          endpoint: "https://example.com/graphql",
          binding: {
            specUrl: "https://example.com/openapi.json",
          },
        } as never,
        now: 1234,
      }))).rejects.toThrow("GraphQL sources cannot define specUrl");

      await expect(Effect.runPromise(createSourceFromPayload({
        workspaceId: WorkspaceIdSchema.make("ws_invalid_internal"),
        sourceId: SourceIdSchema.make("src_invalid_internal"),
        payload: {
          name: "Internal",
          kind: "internal",
          endpoint: "internal://executor",
          binding: {
            defaultHeaders: {
              accept: "application/json",
            },
          },
        } as never,
        now: 1234,
      }))).rejects.toThrow("internal sources cannot define HTTP source settings");
    });

    it("normalizes new auth during updates", async () => {
      const updated = await Effect.runPromise(updateSourceFromPayload({
        source: makeSource({
          auth: { kind: "none" },
        }),
        payload: {
          auth: {
            kind: "bearer",
            headerName: "  ",
            prefix: "Token ",
            token: {
              providerId: " postgres ",
              handle: " sec_token ",
            },
          } as never,
        },
        now: 2000,
      }));

      expect(updated.auth).toEqual({
        kind: "bearer",
        headerName: "Authorization",
        prefix: "Token ",
        token: {
          providerId: "postgres",
          handle: "sec_token",
        },
      });
    });
  });

  describe("storage roundtrip", () => {
    it("roundtrips bearer auth and serialized maps", async () => {
      const source = makeSource({
        kind: "mcp",
        binding: mcpBinding({
          transport: "auto",
          queryParams: { page: "1" },
          headers: { "x-api-key": "secret" },
        }),
        auth: {
          kind: "bearer",
          headerName: "Authorization",
          prefix: "Bearer ",
          token: {
            providerId: "postgres",
            handle: "sec_bearer",
          },
        },
      });
      const recipeId = stableSourceRecipeId(source);
      const recipeRevisionId = stableSourceRecipeRevisionId(source);
      const existingCredentialId = CredentialIdSchema.make("cred_existing");

      const { sourceRecord, runtimeCredential } = splitSourceForStorage({
        source,
        recipeId,
        recipeRevisionId,
        existingRuntimeCredentialId: existingCredentialId,
      });

      expect(runtimeCredential?.id).toBe(existingCredentialId);
      expect(JSON.parse(sourceRecord.bindingConfigJson ?? "{}")).toEqual({
        adapterKey: "mcp",
        version: 1,
        payload: source.binding,
      });

      const projected = await Effect.runPromise(projectSourceFromStorage({
        sourceRecord,
        runtimeCredential: runtimeCredential ?? null,
        importCredential: null,
      }));

      expect(projected).toEqual(source);
    });

    it("roundtrips oauth2 auth with and without refresh tokens", async () => {
      const withRefresh = makeSource({
        kind: "graphql",
        endpoint: "https://example.com/graphql",
        binding: graphqlBinding({ accept: "application/json" }),
        auth: {
          kind: "oauth2",
          headerName: "Authorization",
          prefix: "Bearer ",
          accessToken: {
            providerId: "postgres",
            handle: "sec_access",
          },
          refreshToken: {
            providerId: "postgres",
            handle: "sec_refresh",
          },
        },
      });
      const withoutRefresh = makeSource({
        id: SourceIdSchema.make("src_source_definitions_no_refresh"),
        kind: "graphql",
        endpoint: "https://example.com/graphql",
        binding: graphqlBinding({ accept: "application/json" }),
        auth: {
          kind: "oauth2",
          headerName: "Authorization",
          prefix: "Bearer ",
          accessToken: {
            providerId: "postgres",
            handle: "sec_access",
          },
          refreshToken: null,
        },
      });

      for (const source of [withRefresh, withoutRefresh]) {
        const { sourceRecord, runtimeCredential } = splitSourceForStorage({
          source,
          recipeId: stableSourceRecipeId(source),
          recipeRevisionId: stableSourceRecipeRevisionId(source),
        });
        const projected = await Effect.runPromise(projectSourceFromStorage({
          sourceRecord,
          runtimeCredential: runtimeCredential ?? null,
          importCredential: null,
        }));

        expect(projected).toEqual(source);
      }
    });

    it("stores no credential for auth.kind none and projects back correctly", async () => {
      const source = makeSource({
        auth: { kind: "none" },
      });
      const { sourceRecord, runtimeCredential } = splitSourceForStorage({
        source,
        recipeId: stableSourceRecipeId(source),
        recipeRevisionId: stableSourceRecipeRevisionId(source),
      });

      expect(runtimeCredential).toBeNull();

      const projected = await Effect.runPromise(projectSourceFromStorage({
        sourceRecord,
        runtimeCredential: null,
        importCredential: null,
      }));

      expect(projected.auth).toEqual({ kind: "none" });
      expect(projected).toEqual(source);
    });
  });

  describe("namespaceFromSourceName", () => {
    it("normalizes names into namespace-safe dotted segments", () => {
      expect(namespaceFromSourceName("My API v2!")).toBe("my.api.v2");
      expect(namespaceFromSourceName("   ")).toBe("source");
      expect(namespaceFromSourceName("!!!")).toBe("source");
    });
  });
});

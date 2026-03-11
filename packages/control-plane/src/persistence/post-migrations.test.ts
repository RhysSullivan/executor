import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import {
  AccountIdSchema,
  McpSourceAuthSessionDataJsonSchema,
  OrganizationIdSchema,
  SourceAuthSessionIdSchema,
  SourceIdSchema,
  SourceRecipeIdSchema,
  SourceRecipeRevisionIdSchema,
  WorkspaceIdSchema,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { buildSchema, getIntrospectionQuery, graphqlSync } from "graphql";
import { sql } from "drizzle-orm";

import {
  createSqlControlPlanePersistence,
  type SqlControlPlanePersistence,
} from "./index";
import { runCodeMigrations } from "./code-migrations";
import { loadSourceById } from "../runtime/source-store";

const openApiBindingConfigJson = (specUrl: string): string =>
  JSON.stringify({
    adapterKey: "openapi",
    version: 1,
    payload: {
      specUrl,
      defaultHeaders: null,
    },
  });

const graphqlBindingConfigJson = (): string =>
  JSON.stringify({
    adapterKey: "graphql",
    version: 1,
    payload: {
      defaultHeaders: null,
    },
  });

const baseRevisionRecord = (input: {
  id: ReturnType<typeof SourceRecipeRevisionIdSchema.make>;
  recipeId: ReturnType<typeof SourceRecipeIdSchema.make>;
  revisionNumber: number;
  sourceConfigJson: string;
  manifestJson?: string | null;
  manifestHash?: string | null;
  materializationHash?: string | null;
  createdAt: number;
  updatedAt: number;
}) => ({
  id: input.id,
  recipeId: input.recipeId,
  revisionNumber: input.revisionNumber,
  sourceConfigJson: input.sourceConfigJson,
  manifestJson: input.manifestJson ?? null,
  manifestHash: input.manifestHash ?? null,
  materializationHash: input.materializationHash ?? null,
  createdAt: input.createdAt,
  updatedAt: input.updatedAt,
});

const drizzleDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

const copyMigrationsBefore = (cutoffDirectoryName: string): string => {
  const targetDir = mkdtempSync(path.join(tmpdir(), "executor-cp-migrations-"));
  for (const directoryName of readdirSync(drizzleDir).sort()) {
    if (directoryName >= cutoffDirectoryName) {
      continue;
    }

    cpSync(
      path.join(drizzleDir, directoryName),
      path.join(targetDir, directoryName),
      { recursive: true },
    );
  }

  return targetDir;
};

const makePersistence: Effect.Effect<
  SqlControlPlanePersistence,
  unknown,
  Scope.Scope
> = Effect.acquireRelease(
  createSqlControlPlanePersistence({
    localDataDir: ":memory:",
  }),
  (persistence) =>
    Effect.tryPromise({
      try: () => persistence.close(),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }).pipe(Effect.orDie),
);

const seedMigratedSourceRecipe = (input: {
  persistence: SqlControlPlanePersistence;
  kind: "openapi" | "graphql";
  workspaceId: ReturnType<typeof WorkspaceIdSchema.make>;
  sourceId: ReturnType<typeof SourceIdSchema.make>;
  documentText: string;
}): Effect.Effect<
  {
    recipeRevisionId: ReturnType<typeof SourceRecipeRevisionIdSchema.make>;
  },
  unknown,
  never
> =>
  Effect.gen(function* () {
    const now = Date.now();
    const accountId = AccountIdSchema.make(`acc_${input.sourceId}`);
    const organizationId = OrganizationIdSchema.make(`org_${input.sourceId}`);
    const recipeId = SourceRecipeIdSchema.make(`src_recipe_${input.sourceId}`);
    const recipeRevisionId = SourceRecipeRevisionIdSchema.make(
      `src_recipe_rev_${input.sourceId}`,
    );

    yield* input.persistence.rows.organizations.insert({
      id: organizationId,
      slug: `org-${input.sourceId}`,
      name: `Org ${input.sourceId}`,
      status: "active",
      createdByAccountId: accountId,
      createdAt: now,
      updatedAt: now,
    });
    yield* input.persistence.rows.workspaces.insert({
      id: input.workspaceId,
      organizationId,
      name: `Workspace ${input.sourceId}`,
      createdByAccountId: accountId,
      createdAt: now,
      updatedAt: now,
    });
    yield* input.persistence.rows.sourceRecipes.upsert({
      id: recipeId,
      kind: "http_api",
      adapterKey:
        input.kind === "openapi" ? "openapi" : "graphql",
      providerKey:
        input.kind === "openapi" ? "generic_http" : "generic_graphql",
      name: input.kind === "openapi" ? "GitHub" : "GraphQL Demo",
      summary: null,
      visibility: "workspace",
      latestRevisionId: recipeRevisionId,
      createdAt: now,
      updatedAt: now,
    });
    yield* input.persistence.rows.sourceRecipeRevisions.upsert(baseRevisionRecord({
      id: recipeRevisionId,
      recipeId,
      revisionNumber: 1,
      sourceConfigJson: JSON.stringify(
        input.kind === "openapi"
          ? {
              kind: "openapi",
              endpoint: "https://api.example.com",
              specUrl: "https://api.example.com/openapi.json",
              defaultHeaders: null,
            }
          : {
              kind: "graphql",
              endpoint: "https://api.example.com/graphql",
              defaultHeaders: null,
            },
      ),
      manifestJson: null,
      manifestHash: null,
      materializationHash: null,
      createdAt: now,
      updatedAt: now,
    }));
    yield* input.persistence.rows.sources.insert({
      id: input.sourceId,
      workspaceId: input.workspaceId,
      recipeId,
      recipeRevisionId,
      name: input.kind === "openapi" ? "GitHub" : "GraphQL Demo",
      kind: input.kind,
      endpoint:
        input.kind === "openapi"
          ? "https://api.example.com"
          : "https://api.example.com/graphql",
      status: "connected",
      enabled: true,
      namespace: input.kind === "openapi" ? "github" : "graphql",
      importAuthPolicy: "reuse_runtime",
      bindingConfigJson:
        input.kind === "openapi"
          ? openApiBindingConfigJson("https://api.example.com/openapi.json")
          : graphqlBindingConfigJson(),
      sourceHash: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    yield* input.persistence.rows.sourceRecipeDocuments.replaceForRevision({
      recipeRevisionId,
      documents: [
        {
          id: `src_recipe_doc_${input.sourceId}`,
          recipeRevisionId,
          documentKind:
            input.kind === "openapi" ? "openapi" : "graphql_introspection",
          documentKey:
            input.kind === "openapi"
              ? "https://api.example.com/openapi.json"
              : "https://api.example.com/graphql",
          contentText: input.documentText,
          contentHash: `hash_${input.sourceId}`,
          fetchedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    return { recipeRevisionId };
  });

describe("code-migrations", () => {
  it.scoped("repairs migrated OpenAPI recipes from stored documents", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_post_migration_openapi");
      const sourceId = SourceIdSchema.make("src_post_migration_openapi");
      yield* persistence.rows.codeMigrations.clearAll();

      const openApiDocument = JSON.stringify({
        openapi: "3.0.3",
        info: {
          title: "GitHub",
          version: "1.0.0",
        },
        paths: {
          "/repos/{owner}/{repo}": {
            get: {
              operationId: "repos.getRepo",
              parameters: [
                {
                  name: "owner",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
                {
                  name: "repo",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: {
                200: {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: {
                        $ref: "#/components/schemas/Repository",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Repository: {
              type: "object",
              properties: {
                full_name: { type: "string" },
              },
              required: ["full_name"],
            },
          },
        },
      });

      const { recipeRevisionId } = yield* seedMigratedSourceRecipe({
        persistence,
        kind: "openapi",
        workspaceId,
        sourceId,
        documentText: openApiDocument,
      });

      yield* runCodeMigrations(persistence.rows);

      const revision =
        yield* persistence.rows.sourceRecipeRevisions.getById(recipeRevisionId);
      expect(Option.isSome(revision)).toBe(true);
      expect(revision.pipe(Option.getOrNull)?.manifestJson).not.toBeNull();
      expect(
        (yield* persistence.rows.sourceRecipeSchemaBundles.listByRevisionId(
          recipeRevisionId,
        )).length,
      ).toBe(1);
      expect(
        (yield* persistence.rows.sourceRecipeOperations.listByRevisionId(
          recipeRevisionId,
        )).length,
      ).toBeGreaterThan(0);
    }),
  );

  it.scoped("repairs migrated GraphQL recipes from stored documents", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_post_migration_graphql");
      const sourceId = SourceIdSchema.make("src_post_migration_graphql");
      yield* persistence.rows.codeMigrations.clearAll();
      const schema = buildSchema(`
        type Query {
          viewer: User!
        }

        type Mutation {
          createIssue(title: String!): Issue!
        }

        type User {
          login: String!
        }

        type Issue {
          id: ID!
          title: String!
        }
      `);
      const graphqlDocument = JSON.stringify(
        graphqlSync({
          schema,
          source: getIntrospectionQuery(),
        }),
      );

      const { recipeRevisionId } = yield* seedMigratedSourceRecipe({
        persistence,
        kind: "graphql",
        workspaceId,
        sourceId,
        documentText: graphqlDocument,
      });

      yield* runCodeMigrations(persistence.rows);

      const revision =
        yield* persistence.rows.sourceRecipeRevisions.getById(recipeRevisionId);
      expect(Option.isSome(revision)).toBe(true);
      expect(revision.pipe(Option.getOrNull)?.manifestJson).not.toBeNull();
      expect(
        (yield* persistence.rows.sourceRecipeSchemaBundles.listByRevisionId(
          recipeRevisionId,
        )).length,
      ).toBe(1);
      expect(
        (yield* persistence.rows.sourceRecipeOperations.listByRevisionId(
          recipeRevisionId,
        )).length,
      ).toBeGreaterThan(0);
    }),
  );

  it.scoped("repairs legacy MCP source auth session payloads", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_post_migration_session");
      const sourceId = SourceIdSchema.make("src_post_migration_session");
      yield* persistence.rows.codeMigrations.clearAll();
      const sessionId = SourceAuthSessionIdSchema.make(
        "src_auth_post_migration_session",
      );
      const now = Date.now();

      yield* persistence.rows.sourceAuthSessions.insert({
        id: sessionId,
        workspaceId,
        sourceId,
        actorAccountId: null,
      executionId: null,
      interactionId: null,
      providerKind: "mcp_oauth",
      credentialSlot: "runtime",
      status: "pending",
        state: "state_post_migration_session",
        sessionDataJson: JSON.stringify({
          kind: "mcp_oauth",
          endpoint: "https://api.github.com",
          redirectUri: "http://127.0.0.1/callback",
          scope: null,
          resourceMetadataUrl:
            "https://api.github.com/.well-known/oauth-protected-resource",
          authorizationServerUrl: "https://github.com/login/oauth",
          resourceMetadataJson: '{"issuer":"https://api.github.com"}',
          authorizationServerMetadataJson:
            '{"token_endpoint":"https://github.com/login/oauth/access_token"}',
          clientInformationJson: '{"client_id":"abc123"}',
          codeVerifier: "verifier",
          authorizationUrl: "https://github.com/login/oauth/authorize",
        }),
        errorText: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      yield* runCodeMigrations(persistence.rows);

      const session =
        yield* persistence.rows.sourceAuthSessions.getById(sessionId);
      expect(Option.isSome(session)).toBe(true);
      const repairedSession = session.pipe(Option.getOrNull);
      expect(repairedSession).not.toBeNull();
      const repaired = Schema.decodeUnknownSync(
        McpSourceAuthSessionDataJsonSchema,
      )(repairedSession!.sessionDataJson);
      expect(repaired.resourceMetadata).toEqual({
        issuer: "https://api.github.com",
      });
      expect(repaired.authorizationServerMetadata).toEqual({
        token_endpoint: "https://github.com/login/oauth/access_token",
      });
      expect(repaired.clientInformation).toEqual({
        client_id: "abc123",
      });
    }),
  );

  it("upgrades legacy source binding columns into adapter-owned binding config", async () => {
    const localDataDir = mkdtempSync(path.join(tmpdir(), "executor-cp-db-"));
    const legacyMigrationsDir = copyMigrationsBefore(
      "20260311010000_source_binding_configs",
    );
    const workspaceId = WorkspaceIdSchema.make("ws_legacy_source_bindings");
    const accountId = AccountIdSchema.make("acc_legacy_source_bindings");
    const organizationId = OrganizationIdSchema.make("org_legacy_source_bindings");
    const now = Date.now();
    let legacyPersistence: SqlControlPlanePersistence | null = null;
    let upgradedPersistence: SqlControlPlanePersistence | null = null;

    try {
      legacyPersistence = await Effect.runPromise(
        createSqlControlPlanePersistence({
          localDataDir,
          migrationsFolder: legacyMigrationsDir,
          runCodeMigrations: false,
        }),
      );

      await Effect.runPromise(legacyPersistence.rows.organizations.insert({
        id: organizationId,
        slug: "org-legacy-source-bindings",
        name: "Legacy Org",
        status: "active",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      }));
      await Effect.runPromise(legacyPersistence.rows.workspaces.insert({
        id: workspaceId,
        organizationId,
        name: "Legacy Workspace",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      }));

      const seedRecipe = async (input: {
        sourceId: string;
        kind: "openapi" | "graphql" | "mcp";
        adapterKey: string;
        providerKey: string;
        name: string;
        endpoint: string;
        sourceConfigJson: string;
      }) => {
        const recipeId = SourceRecipeIdSchema.make(`src_recipe_${input.sourceId}`);
        const recipeRevisionId = SourceRecipeRevisionIdSchema.make(
          `src_recipe_rev_${input.sourceId}`,
        );

        await legacyPersistence!.db.execute(sql`
          INSERT INTO "source_recipes" (
            "id",
            "kind",
            "importer_kind",
            "provider_key",
            "name",
            "summary",
            "visibility",
            "latest_revision_id",
            "created_at",
            "updated_at"
          ) VALUES (
            ${recipeId},
            ${input.kind === "mcp" ? "mcp" : "http_api"},
            ${input.adapterKey},
            ${input.providerKey},
            ${input.name},
            NULL,
            'workspace',
            ${recipeRevisionId},
            ${now},
            ${now}
          )
        `);
        await legacyPersistence!.db.execute(sql`
          INSERT INTO "source_recipe_revisions" (
            "id",
            "recipe_id",
            "revision_number",
            "source_config_json",
            "manifest_json",
            "manifest_hash",
            "created_at",
            "updated_at"
          ) VALUES (
            ${recipeRevisionId},
            ${recipeId},
            1,
            ${input.sourceConfigJson},
            NULL,
            NULL,
            ${now},
            ${now}
          )
        `);

        return { recipeId, recipeRevisionId };
      };

      const openapi = await seedRecipe({
        sourceId: "src_legacy_openapi",
        kind: "openapi",
        adapterKey: "openapi",
        providerKey: "generic_http",
        name: "Legacy OpenAPI",
        endpoint: "https://api.example.com",
        sourceConfigJson: JSON.stringify({
          kind: "openapi",
          endpoint: "https://api.example.com",
          specUrl: "https://api.example.com/openapi.json",
          defaultHeaders: { accept: "application/json" },
        }),
      });
      const graphql = await seedRecipe({
        sourceId: "src_legacy_graphql",
        kind: "graphql",
        adapterKey: "graphql_introspection",
        providerKey: "generic_graphql",
        name: "Legacy GraphQL",
        endpoint: "https://api.example.com/graphql",
        sourceConfigJson: JSON.stringify({
          kind: "graphql",
          endpoint: "https://api.example.com/graphql",
          defaultHeaders: { accept: "application/json" },
        }),
      });
      const mcp = await seedRecipe({
        sourceId: "src_legacy_mcp",
        kind: "mcp",
        adapterKey: "mcp_manifest",
        providerKey: "generic_mcp",
        name: "Legacy MCP",
        endpoint: "https://api.example.com/mcp",
        sourceConfigJson: JSON.stringify({
          kind: "mcp",
          endpoint: "https://api.example.com/mcp",
          transport: "streamable-http",
          queryParams: { tenant: "acme" },
          headers: { "x-tenant": "acme" },
        }),
      });

      await legacyPersistence.db.execute(sql`
        INSERT INTO "sources" (
          "workspace_id",
          "source_id",
          "recipe_id",
          "recipe_revision_id",
          "name",
          "kind",
          "endpoint",
          "status",
          "enabled",
          "namespace",
          "binding_config_json",
          "transport",
          "query_params_json",
          "headers_json",
          "spec_url",
          "default_headers_json",
          "source_hash",
          "source_document_text",
          "last_error",
          "created_at",
          "updated_at"
        ) VALUES
        (
          ${workspaceId},
          ${SourceIdSchema.make("src_legacy_openapi")},
          ${openapi.recipeId},
          ${openapi.recipeRevisionId},
          'Legacy OpenAPI',
          'openapi',
          'https://api.example.com',
          'connected',
          true,
          'legacy.openapi',
          NULL,
          NULL,
          NULL,
          NULL,
          'https://api.example.com/openapi.json',
          '{"accept":"application/json"}',
          NULL,
          NULL,
          NULL,
          ${now},
          ${now}
        ),
        (
          ${workspaceId},
          ${SourceIdSchema.make("src_legacy_graphql")},
          ${graphql.recipeId},
          ${graphql.recipeRevisionId},
          'Legacy GraphQL',
          'graphql',
          'https://api.example.com/graphql',
          'connected',
          true,
          'legacy.graphql',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          '{"accept":"application/json"}',
          NULL,
          NULL,
          NULL,
          ${now},
          ${now}
        ),
        (
          ${workspaceId},
          ${SourceIdSchema.make("src_legacy_mcp")},
          ${mcp.recipeId},
          ${mcp.recipeRevisionId},
          'Legacy MCP',
          'mcp',
          'https://api.example.com/mcp',
          'connected',
          true,
          'legacy.mcp',
          NULL,
          'streamable-http',
          '{"tenant":"acme"}',
          '{"x-tenant":"acme"}',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          ${now},
          ${now}
        );
      `);

      await legacyPersistence.close();
      legacyPersistence = null;

      upgradedPersistence = await Effect.runPromise(
        createSqlControlPlanePersistence({
          localDataDir,
        }),
      );

      const openApiSource = await Effect.runPromise(loadSourceById(
        upgradedPersistence.rows,
        {
          workspaceId,
          sourceId: SourceIdSchema.make("src_legacy_openapi"),
        },
      ));
      expect(openApiSource.binding).toEqual({
        specUrl: "https://api.example.com/openapi.json",
        defaultHeaders: {
          accept: "application/json",
        },
      });
      expect(openApiSource.bindingVersion).toBe(1);

      const graphqlSource = await Effect.runPromise(loadSourceById(
        upgradedPersistence.rows,
        {
          workspaceId,
          sourceId: SourceIdSchema.make("src_legacy_graphql"),
        },
      ));
      expect(graphqlSource.binding).toEqual({
        defaultHeaders: {
          accept: "application/json",
        },
      });

      const graphqlRecipe = await Effect.runPromise(
        upgradedPersistence.rows.sourceRecipes.getById(graphql.recipeId),
      );
      expect(Option.getOrNull(graphqlRecipe)?.adapterKey).toBe("graphql");

      const mcpSource = await Effect.runPromise(loadSourceById(
        upgradedPersistence.rows,
        {
          workspaceId,
          sourceId: SourceIdSchema.make("src_legacy_mcp"),
        },
      ));
      expect(mcpSource.binding).toEqual({
        transport: "streamable-http",
        queryParams: {
          tenant: "acme",
        },
        headers: {
          "x-tenant": "acme",
        },
      });

      const mcpRecipe = await Effect.runPromise(
        upgradedPersistence.rows.sourceRecipes.getById(mcp.recipeId),
      );
      expect(Option.getOrNull(mcpRecipe)?.adapterKey).toBe("mcp");
    } finally {
      await legacyPersistence?.close().catch(() => undefined);
      await upgradedPersistence?.close().catch(() => undefined);
      rmSync(localDataDir, { recursive: true, force: true });
      rmSync(legacyMigrationsDir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import {
  AccountIdSchema,
  CredentialIdSchema,
  McpSourceAuthSessionDataJsonSchema,
  OrganizationIdSchema,
  OrganizationMemberIdSchema,
  PolicyIdSchema,
  SecretMaterialIdSchema,
  SourceAuthSessionIdSchema,
  SourceIdSchema,
  SourceRecipeIdSchema,
  SourceRecipeSchemaBundleIdSchema,
  SourceRecipeRevisionIdSchema,
  WorkspaceIdSchema,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  createSqlControlPlanePersistence,
  type SqlControlPlanePersistence,
} from "./index";
import { drizzleSchema } from "./schema";

const makePersistence: Effect.Effect<SqlControlPlanePersistence, unknown, Scope.Scope> =
  Effect.acquireRelease(
  createSqlControlPlanePersistence({
    localDataDir: ":memory:",
  }),
  (persistence) =>
    Effect.tryPromise({
      try: () => persistence.close(),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.orDie),
  );

const encodeSessionDataJson = Schema.encodeSync(McpSourceAuthSessionDataJsonSchema);

const openApiBindingConfigJson = (specUrl: string): string =>
  JSON.stringify({
    adapterKey: "openapi",
    version: 1,
    payload: {
      specUrl,
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

const seedWorkspaceSourceState = (input: {
  persistence: SqlControlPlanePersistence;
  accountId: ReturnType<typeof AccountIdSchema.make>;
  organizationId: ReturnType<typeof OrganizationIdSchema.make>;
  workspaceId: ReturnType<typeof WorkspaceIdSchema.make>;
  sourceId: ReturnType<typeof SourceIdSchema.make>;
}): Effect.Effect<void, unknown, never> =>
  Effect.gen(function* () {
    const now = Date.now();
    const recipeId = SourceRecipeIdSchema.make(`src_recipe_${input.sourceId}`);
    const recipeRevisionId = SourceRecipeRevisionIdSchema.make(`src_recipe_rev_${input.sourceId}`);

    yield* input.persistence.rows.organizations.insert({
      id: input.organizationId,
      slug: `org-${input.organizationId}`,
      name: `Org ${input.organizationId}`,
      status: "active",
      createdByAccountId: input.accountId,
      createdAt: now,
      updatedAt: now,
    });
    yield* input.persistence.rows.workspaces.insert({
      id: input.workspaceId,
      organizationId: input.organizationId,
      name: `Workspace ${input.workspaceId}`,
      createdByAccountId: input.accountId,
      createdAt: now,
      updatedAt: now,
    });
    yield* input.persistence.rows.sourceRecipes.upsert({
      id: recipeId,
      kind: "http_api",
      adapterKey: "openapi",
      providerKey: "openapi:https://api.github.com",
      name: "Github",
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
      sourceConfigJson: JSON.stringify({
        kind: "openapi",
        endpoint: "https://api.github.com",
        specUrl: "https://api.github.com/openapi.json",
      }),
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
      name: "Github",
      kind: "openapi",
      endpoint: "https://api.github.com",
      status: "connected",
      enabled: true,
      namespace: "github",
      importAuthPolicy: "reuse_runtime",
      bindingConfigJson: openApiBindingConfigJson("https://api.github.com/openapi.json"),
      sourceHash: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  });

const seedWorkspaceCredentialState = (input: {
  persistence: SqlControlPlanePersistence;
  accountId: ReturnType<typeof AccountIdSchema.make>;
  organizationId: ReturnType<typeof OrganizationIdSchema.make>;
  workspaceId: ReturnType<typeof WorkspaceIdSchema.make>;
  sourceId: ReturnType<typeof SourceIdSchema.make>;
}): Effect.Effect<{
  tokenId: ReturnType<typeof SecretMaterialIdSchema.make>;
  refreshId: ReturnType<typeof SecretMaterialIdSchema.make>;
}, unknown, never> =>
  Effect.gen(function* () {
    const now = Date.now();
    const credentialId = CredentialIdSchema.make(`cred_${input.workspaceId}`);
    const tokenId = SecretMaterialIdSchema.make(`sec_${input.workspaceId}_token`);
    const refreshId = SecretMaterialIdSchema.make(`sec_${input.workspaceId}_refresh`);

    yield* seedWorkspaceSourceState(input);
    yield* input.persistence.rows.secretMaterials.upsert({
      id: tokenId,
      name: null,
      purpose: "oauth_access_token",
      value: "token",
      createdAt: now,
      updatedAt: now,
    });
    yield* input.persistence.rows.secretMaterials.upsert({
      id: refreshId,
      name: null,
      purpose: "oauth_refresh_token",
      value: "refresh",
      createdAt: now,
      updatedAt: now,
    });
    yield* input.persistence.rows.credentials.upsert({
      id: credentialId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      actorAccountId: input.accountId,
      slot: "runtime",
      authKind: "oauth2",
      authHeaderName: "Authorization",
      authPrefix: "Bearer ",
      tokenProviderId: "postgres",
      tokenHandle: tokenId,
      refreshTokenProviderId: "postgres",
      refreshTokenHandle: refreshId,
      createdAt: now,
      updatedAt: now,
    });
    yield* input.persistence.rows.sourceAuthSessions.upsert({
      id: SourceAuthSessionIdSchema.make(`src_auth_${input.workspaceId}`),
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      actorAccountId: input.accountId,
      executionId: null,
      interactionId: null,
      providerKind: "mcp_oauth",
      credentialSlot: "runtime",
      status: "pending",
      state: `state_${input.workspaceId}`,
      sessionDataJson: encodeSessionDataJson({
        kind: "mcp_oauth",
        endpoint: "https://api.github.com",
        redirectUri: "http://127.0.0.1/callback",
        scope: null,
        resourceMetadataUrl: null,
        authorizationServerUrl: null,
        resourceMetadata: null,
        authorizationServerMetadata: null,
        clientInformation: null,
        codeVerifier: "verifier",
        authorizationUrl: "https://example.com/auth",
      }),
      errorText: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    return { tokenId, refreshId };
  });

describe("control-plane-persistence-drizzle", () => {
  it.scoped("creates and reads organization/workspace/source/policy rows", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();
      const organizationId = OrganizationIdSchema.make("org_1");
      const accountId = AccountIdSchema.make("acc_1");
      const workspaceId = WorkspaceIdSchema.make("ws_1");

      yield* persistence.rows.organizations.insert({
        id: organizationId,
        slug: "acme",
        name: "Acme",
        status: "active",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.workspaces.insert({
        id: workspaceId,
        organizationId,
        name: "Main",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.sources.insert({
        id: SourceIdSchema.make("src_1"),
        workspaceId,
        recipeId: SourceRecipeIdSchema.make("src_recipe_1"),
        recipeRevisionId: SourceRecipeRevisionIdSchema.make("src_recipe_rev_1"),
        name: "Github",
        kind: "openapi",
        endpoint: "https://api.github.com",
        status: "draft",
        enabled: true,
        namespace: "github",
        importAuthPolicy: "reuse_runtime",
        bindingConfigJson: openApiBindingConfigJson("https://api.github.com/openapi.json"),
        sourceHash: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.policies.insert({
        id: PolicyIdSchema.make("pol_1"),
        scopeType: "workspace",
        organizationId,
        workspaceId,
        targetAccountId: null,
        clientId: null,
        resourceType: "tool_path",
        resourcePattern: "source.github.*",
        matchType: "glob",
        effect: "allow",
        approvalMode: "auto",
        argumentConditionsJson: null,
        priority: 10,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });

      const workspace = yield* persistence.rows.workspaces.getById(workspaceId);
      assertTrue(Option.isSome(workspace));

      const sources = yield* persistence.rows.sources.listByWorkspaceId(workspaceId);
      expect(sources).toHaveLength(1);
      expect(sources[0]?.name).toBe("Github");

      const policies = yield* persistence.rows.policies.listByWorkspaceId(workspaceId);
      expect(policies).toHaveLength(1);
      expect(policies[0]?.resourcePattern).toBe("source.github.*");
    }),
  );

  it.scoped("upserts organization memberships by org/account", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();
      const organizationId = OrganizationIdSchema.make("org_1");
      const accountId = AccountIdSchema.make("acc_1");

      yield* persistence.rows.organizationMemberships.upsert({
        id: OrganizationMemberIdSchema.make("mem_1"),
        organizationId,
        accountId,
        role: "viewer",
        status: "active",
        billable: true,
        invitedByAccountId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.organizationMemberships.upsert({
        id: OrganizationMemberIdSchema.make("mem_2"),
        organizationId,
        accountId,
        role: "admin",
        status: "active",
        billable: true,
        invitedByAccountId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now + 1,
      });

      const membership = yield* persistence.rows.organizationMemberships.getByOrganizationAndAccount(
        organizationId,
        accountId,
      );

      assertTrue(Option.isSome(membership));
      if (Option.isSome(membership)) {
        expect(membership.value.role).toBe("admin");
      }
    }),
  );

  it.scoped("batches large recipe operation replacement inserts", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();
      const recipeId = SourceRecipeIdSchema.make("src_recipe_bulk_ops");
      const recipeRevisionId = SourceRecipeRevisionIdSchema.make("src_recipe_rev_bulk_ops");
      const operationCount = 3_000;

      yield* persistence.rows.sourceRecipes.upsert({
        id: recipeId,
        kind: "http_api",
        adapterKey: "openapi",
        providerKey: "openapi:https://api.cloudflare.com/client/v4",
        name: "Cloudflare API",
        summary: null,
        visibility: "private",
        latestRevisionId: recipeRevisionId,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.sourceRecipeRevisions.upsert(baseRevisionRecord({
        id: recipeRevisionId,
        recipeId,
        revisionNumber: 1,
        sourceConfigJson: JSON.stringify({
          endpoint: "https://api.cloudflare.com/client/v4",
          specUrl:
            "https://raw.githubusercontent.com/cloudflare/api-schemas/refs/heads/main/openapi.json",
        }),
        manifestHash: null,
        manifestJson: null,
        materializationHash: null,
        createdAt: now,
        updatedAt: now,
      }));

      yield* persistence.rows.sourceRecipeOperations.replaceForRevision({
        recipeRevisionId,
        operations: Array.from({ length: operationCount }, (_, index) => ({
          id: `src_recipe_op_${index}`,
          recipeRevisionId,
          operationKey: `zones.get${index}`,
          transportKind: "http" as const,
          toolId: `zones.get${index}`,
          title: `Get zone ${index}`,
          description: `Operation ${index}`,
          operationKind: "read" as const,
          searchText: `zones get ${index}`,
          inputSchemaJson: null,
          outputSchemaJson: null,
          providerKind: "openapi" as const,
          providerDataJson: JSON.stringify({
            kind: "openapi",
            toolId: `zones.get${index}`,
            rawToolId: `getZone${index}`,
            operationId: `getZone${index}`,
            group: "zones",
            leaf: `get${index}`,
            tags: ["zones"],
            method: "get",
            path: `/zones/${index}`,
            operationHash: `hash_${index}`,
            invocation: {
              method: "get",
              pathTemplate: `/zones/${index}`,
              parameters: [],
              requestBody: null,
            },
          }),
          createdAt: now,
          updatedAt: now,
        })),
      });

      const operations = yield* persistence.rows.sourceRecipeOperations.listByRevisionId(
        recipeRevisionId,
      );
      expect(operations).toHaveLength(operationCount);
      expect(operations.some((operation) => operation.toolId === "zones.get0")).toBe(true);
      expect(
        operations.some(
          (operation) => operation.toolId === `zones.get${operationCount - 1}`,
        ),
      ).toBe(true);
    }),
  );

  it.scoped("deduplicates null-actor credentials and returns actor/shared matches", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const accountId = AccountIdSchema.make("acc_credentials");
      const organizationId = OrganizationIdSchema.make("org_credentials");
      const workspaceId = WorkspaceIdSchema.make("ws_credentials");
      const sourceId = SourceIdSchema.make("src_credentials");
      const actorCredentialId = CredentialIdSchema.make("cred_actor_credentials");
      const nullCredentialA = CredentialIdSchema.make("cred_null_credentials_a");
      const nullCredentialB = CredentialIdSchema.make("cred_null_credentials_b");
      const now = Date.now();

      yield* seedWorkspaceSourceState({
        persistence,
        accountId,
        organizationId,
        workspaceId,
        sourceId,
      });

      yield* Effect.tryPromise(async () => {
        await persistence.db.insert(drizzleSchema.credentialsTable).values([
          {
            id: nullCredentialA,
            workspaceId,
            sourceId,
            actorAccountId: null,
            slot: "runtime",
            authKind: "bearer",
            authHeaderName: "Authorization",
            authPrefix: "Bearer ",
            tokenProviderId: "postgres",
            tokenHandle: "sec_null_a",
            refreshTokenProviderId: null,
            refreshTokenHandle: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: nullCredentialB,
            workspaceId,
            sourceId,
            actorAccountId: null,
            slot: "runtime",
            authKind: "bearer",
            authHeaderName: "Authorization",
            authPrefix: "Bearer ",
            tokenProviderId: "postgres",
            tokenHandle: "sec_null_b",
            refreshTokenProviderId: null,
            refreshTokenHandle: null,
            createdAt: now + 1,
            updatedAt: now + 1,
          },
        ]);
      }).pipe(Effect.orDie);

      yield* persistence.rows.credentials.upsert({
        id: CredentialIdSchema.make("cred_null_credentials_replacement"),
        workspaceId,
        sourceId,
        actorAccountId: null,
        slot: "runtime",
        authKind: "oauth2",
        authHeaderName: "X-Auth",
        authPrefix: "Token ",
        tokenProviderId: "postgres",
        tokenHandle: "sec_null_replacement",
        refreshTokenProviderId: "postgres",
        refreshTokenHandle: "sec_null_refresh",
        createdAt: now + 2,
        updatedAt: now + 2,
      });

      yield* persistence.rows.credentials.upsert({
        id: actorCredentialId,
        workspaceId,
        sourceId,
        actorAccountId: accountId,
        slot: "runtime",
        authKind: "bearer",
        authHeaderName: "Authorization",
        authPrefix: "Bearer ",
        tokenProviderId: "postgres",
        tokenHandle: "sec_actor",
        refreshTokenProviderId: null,
        refreshTokenHandle: null,
        createdAt: now + 3,
        updatedAt: now + 3,
      });

      const allCredentials = yield* persistence.rows.credentials.listByWorkspaceAndSourceId({
        workspaceId,
        sourceId,
      });
      expect(allCredentials).toHaveLength(2);
      const nullActorCredentials = allCredentials.filter((credential) => credential.actorAccountId === null);
      expect(nullActorCredentials).toHaveLength(1);
      expect(nullActorCredentials[0]?.id).toBe(nullCredentialA);
      expect(nullActorCredentials[0]?.authKind).toBe("oauth2");
      expect(nullActorCredentials[0]?.authHeaderName).toBe("X-Auth");
      expect(nullActorCredentials[0]?.tokenHandle).toBe("sec_null_replacement");
      expect(allCredentials.map((credential) => credential.id).sort()).toEqual(
        [actorCredentialId, nullCredentialA].sort(),
      );

      const forActor = yield* persistence.rows.credentials.listByWorkspaceSourceAndActor({
        workspaceId,
        sourceId,
        actorAccountId: accountId,
      });
      expect(forActor).toHaveLength(2);
      expect(new Set(forActor.map((credential) => credential.id))).toEqual(
        new Set([actorCredentialId, nullCredentialA]),
      );

      const nullActorOnly = yield* persistence.rows.credentials.getByWorkspaceSourceAndActor({
        workspaceId,
        sourceId,
        actorAccountId: null,
        slot: "runtime",
      });
      assertTrue(Option.isSome(nullActorOnly));
      if (Option.isSome(nullActorOnly)) {
        expect(nullActorOnly.value.id).toBe(nullCredentialA);
      }

      const missingActor = yield* persistence.rows.credentials.getByWorkspaceSourceAndActor({
        workspaceId,
        sourceId,
        actorAccountId: AccountIdSchema.make("acc_missing_credentials"),
        slot: "runtime",
      });
      expect(Option.isNone(missingActor)).toBe(true);
    }),
  );

  it.scoped("deleting a workspace removes source credentials, sessions, and postgres secrets", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const accountId = AccountIdSchema.make("acc_ws_cleanup");
      const organizationId = OrganizationIdSchema.make("org_ws_cleanup");
      const workspaceId = WorkspaceIdSchema.make("ws_cleanup");
      const sourceId = SourceIdSchema.make("src_ws_cleanup");
      const recipeRevisionId = SourceRecipeRevisionIdSchema.make(`src_recipe_rev_${sourceId}`);

      const { tokenId, refreshId } = yield* seedWorkspaceCredentialState({
        persistence,
        accountId,
        organizationId,
        workspaceId,
        sourceId,
      });
      yield* persistence.rows.sourceRecipeDocuments.replaceForRevision({
        recipeRevisionId,
        documents: [
          {
            id: "src_recipe_doc_ws_cleanup",
            recipeRevisionId,
            documentKind: "openapi",
            documentKey: "https://api.github.com/openapi.json",
            contentText: "{\"openapi\":\"3.1.0\"}",
            contentHash: "doc_hash_ws_cleanup",
            fetchedAt: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });
      yield* persistence.rows.sourceRecipeSchemaBundles.replaceForRevision({
        recipeRevisionId,
        bundles: [
          {
            id: SourceRecipeSchemaBundleIdSchema.make("src_recipe_bundle_ws_cleanup"),
            recipeRevisionId,
            bundleKind: "json_schema_ref_map",
            refsJson: "{}",
            contentHash: "bundle_hash_ws_cleanup",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });
      yield* persistence.rows.sourceRecipeOperations.replaceForRevision({
        recipeRevisionId,
        operations: [
          {
            id: "src_recipe_op_ws_cleanup",
            recipeRevisionId,
            operationKey: "users.getAuthenticated",
            transportKind: "http",
            toolId: "users.getAuthenticated",
            title: "Get authenticated user",
            description: null,
            operationKind: "read",
            searchText: "users get authenticated",
            inputSchemaJson: null,
            outputSchemaJson: null,
            providerKind: "openapi",
            providerDataJson: JSON.stringify({
              kind: "openapi",
              toolId: "users.getAuthenticated",
              rawToolId: "users.getAuthenticated",
              operationId: "users.getAuthenticated",
              group: "users",
              leaf: "getAuthenticated",
              tags: ["users"],
              method: "get",
              path: "/user",
              operationHash: "op_hash_ws_cleanup",
              invocation: {
                method: "get",
                pathTemplate: "/user",
                pathParameterOrder: [],
                serverUrl: "https://api.github.com",
                parameters: [],
                requestBody: null,
              },
            }),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });

      const removed = yield* persistence.rows.workspaces.removeById(workspaceId);
      expect(removed).toBe(true);
      expect(Option.isNone(yield* persistence.rows.workspaces.getById(workspaceId))).toBe(true);
      expect(yield* persistence.rows.credentials.listByWorkspaceId(workspaceId)).toHaveLength(0);
      expect(yield* persistence.rows.sourceAuthSessions.listByWorkspaceId(workspaceId)).toHaveLength(0);
      expect(
        yield* persistence.rows.sourceRecipeDocuments.listByRevisionId(recipeRevisionId),
      ).toHaveLength(0);
      expect(
        yield* persistence.rows.sourceRecipeSchemaBundles.listByRevisionId(recipeRevisionId),
      ).toHaveLength(0);
      expect(
        yield* persistence.rows.sourceRecipeOperations.listByRevisionId(recipeRevisionId),
      ).toHaveLength(0);
      expect(Option.isNone(yield* persistence.rows.secretMaterials.getById(tokenId))).toBe(true);
      expect(Option.isNone(yield* persistence.rows.secretMaterials.getById(refreshId))).toBe(true);
    }),
  );

  it.scoped("deleting a workspace retains shared recipe data still referenced elsewhere", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();
      const accountId = AccountIdSchema.make("acc_shared_recipe");
      const organizationId = OrganizationIdSchema.make("org_shared_recipe");
      const removedWorkspaceId = WorkspaceIdSchema.make("ws_shared_removed");
      const remainingWorkspaceId = WorkspaceIdSchema.make("ws_shared_remaining");
      const sharedRecipeId = SourceRecipeIdSchema.make("src_recipe_shared_workspace");
      const sharedRecipeRevisionId = SourceRecipeRevisionIdSchema.make(
        "src_recipe_rev_shared_workspace",
      );

      yield* persistence.rows.organizations.insert({
        id: organizationId,
        slug: "org-shared-recipe",
        name: "Org Shared Recipe",
        status: "active",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.workspaces.insert({
        id: removedWorkspaceId,
        organizationId,
        name: "Workspace Removed",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.workspaces.insert({
        id: remainingWorkspaceId,
        organizationId,
        name: "Workspace Remaining",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.sourceRecipes.upsert({
        id: sharedRecipeId,
        kind: "http_api",
        adapterKey: "openapi",
        providerKey: "openapi:https://api.github.com",
        name: "Github",
        summary: null,
        visibility: "workspace",
        latestRevisionId: sharedRecipeRevisionId,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.sourceRecipeRevisions.upsert(baseRevisionRecord({
        id: sharedRecipeRevisionId,
        recipeId: sharedRecipeId,
        revisionNumber: 1,
        sourceConfigJson: JSON.stringify({
          kind: "openapi",
          endpoint: "https://api.github.com",
          specUrl: "https://api.github.com/openapi.json",
        }),
        manifestJson: null,
        manifestHash: null,
        materializationHash: null,
        createdAt: now,
        updatedAt: now,
      }));
      yield* persistence.rows.sourceRecipeDocuments.replaceForRevision({
        recipeRevisionId: sharedRecipeRevisionId,
        documents: [
          {
            id: "src_recipe_doc_shared_workspace",
            recipeRevisionId: sharedRecipeRevisionId,
            documentKind: "openapi",
            documentKey: "https://api.github.com/openapi.json",
            contentText: "{\"openapi\":\"3.1.0\"}",
            contentHash: "doc_hash_shared_workspace",
            fetchedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      yield* persistence.rows.sourceRecipeSchemaBundles.replaceForRevision({
        recipeRevisionId: sharedRecipeRevisionId,
        bundles: [
          {
            id: SourceRecipeSchemaBundleIdSchema.make("src_recipe_bundle_shared_workspace"),
            recipeRevisionId: sharedRecipeRevisionId,
            bundleKind: "json_schema_ref_map",
            refsJson: "{}",
            contentHash: "bundle_hash_shared_workspace",
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      yield* persistence.rows.sourceRecipeOperations.replaceForRevision({
        recipeRevisionId: sharedRecipeRevisionId,
        operations: [
          {
            id: "src_recipe_op_shared_workspace",
            recipeRevisionId: sharedRecipeRevisionId,
            operationKey: "users.getAuthenticated",
            transportKind: "http",
            toolId: "users.getAuthenticated",
            title: "Get authenticated user",
            description: null,
            operationKind: "read",
            searchText: "users get authenticated",
            inputSchemaJson: null,
            outputSchemaJson: null,
            providerKind: "openapi",
            providerDataJson: JSON.stringify({
              kind: "openapi",
              toolId: "users.getAuthenticated",
              rawToolId: "users.getAuthenticated",
              operationId: "users.getAuthenticated",
              group: "users",
              leaf: "getAuthenticated",
              tags: ["users"],
              method: "get",
              path: "/user",
              operationHash: "op_hash_shared_workspace",
              invocation: {
                method: "get",
                pathTemplate: "/user",
                pathParameterOrder: [],
                serverUrl: "https://api.github.com",
                parameters: [],
                requestBody: null,
              },
            }),
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      yield* persistence.rows.sources.insert({
        id: SourceIdSchema.make("src_shared_removed"),
        workspaceId: removedWorkspaceId,
        recipeId: sharedRecipeId,
        recipeRevisionId: sharedRecipeRevisionId,
        name: "Github Removed",
        kind: "openapi",
        endpoint: "https://api.github.com",
        status: "connected",
        enabled: true,
        namespace: "github",
        importAuthPolicy: "reuse_runtime",
        bindingConfigJson: openApiBindingConfigJson("https://api.github.com/openapi.json"),
        sourceHash: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.sources.insert({
        id: SourceIdSchema.make("src_shared_remaining"),
        workspaceId: remainingWorkspaceId,
        recipeId: sharedRecipeId,
        recipeRevisionId: sharedRecipeRevisionId,
        name: "Github Remaining",
        kind: "openapi",
        endpoint: "https://api.github.com",
        status: "connected",
        enabled: true,
        namespace: "github",
        importAuthPolicy: "reuse_runtime",
        bindingConfigJson: openApiBindingConfigJson("https://api.github.com/openapi.json"),
        sourceHash: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });

      const removed = yield* persistence.rows.workspaces.removeById(removedWorkspaceId);
      expect(removed).toBe(true);
      expect(Option.isNone(yield* persistence.rows.workspaces.getById(removedWorkspaceId))).toBe(true);
      expect(Option.isSome(yield* persistence.rows.workspaces.getById(remainingWorkspaceId))).toBe(true);
      expect(
        yield* persistence.rows.sources.listByWorkspaceId(remainingWorkspaceId),
      ).toHaveLength(1);
      expect(
        Option.isSome(yield* persistence.rows.sourceRecipes.getById(sharedRecipeId)),
      ).toBe(true);
      expect(
        Option.isSome(yield* persistence.rows.sourceRecipeRevisions.getById(sharedRecipeRevisionId)),
      ).toBe(true);
      expect(
        yield* persistence.rows.sourceRecipeDocuments.listByRevisionId(sharedRecipeRevisionId),
      ).toHaveLength(1);
      expect(
        yield* persistence.rows.sourceRecipeSchemaBundles.listByRevisionId(sharedRecipeRevisionId),
      ).toHaveLength(1);
      expect(
        yield* persistence.rows.sourceRecipeOperations.listByRevisionId(sharedRecipeRevisionId),
      ).toHaveLength(1);
    }),
  );

  it.scoped("deleting an organization removes workspace credential state and postgres secrets", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const accountId = AccountIdSchema.make("acc_org_cleanup");
      const organizationId = OrganizationIdSchema.make("org_cleanup");
      const workspaceId = WorkspaceIdSchema.make("ws_org_cleanup");
      const sourceId = SourceIdSchema.make("src_org_cleanup");

      const { tokenId, refreshId } = yield* seedWorkspaceCredentialState({
        persistence,
        accountId,
        organizationId,
        workspaceId,
        sourceId,
      });

      const removed = yield* persistence.rows.organizations.removeTreeById(organizationId);
      expect(removed).toBe(true);
      expect(Option.isNone(yield* persistence.rows.workspaces.getById(workspaceId))).toBe(true);
      expect(yield* persistence.rows.credentials.listByWorkspaceId(workspaceId)).toHaveLength(0);
      expect(yield* persistence.rows.sourceAuthSessions.listByWorkspaceId(workspaceId)).toHaveLength(0);
      expect(Option.isNone(yield* persistence.rows.secretMaterials.getById(tokenId))).toBe(true);
      expect(Option.isNone(yield* persistence.rows.secretMaterials.getById(refreshId))).toBe(true);
    }),
  );
});

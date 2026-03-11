import { describe, expect, it } from "@effect/vitest";

import {
  AccountIdSchema,
  McpSourceAuthSessionDataJsonSchema,
  OrganizationIdSchema,
  SecretMaterialIdSchema,
  SourceAuthSessionIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
  type Source,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  createSqlControlPlanePersistence,
  type SqlControlPlanePersistence,
} from "../persistence";
import {
  stableSourceRecipeId,
  stableSourceRecipeRevisionId,
} from "./source-definitions";
import { persistSource, removeSourceById } from "./source-store";

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

const makeOpenApiSource = (input: {
  workspaceId: Source["workspaceId"];
  sourceId: Source["id"];
  now: number;
  updatedAt?: number;
  name?: string;
  endpoint?: string;
  specUrl?: string;
  auth: Source["auth"];
}): Source => ({
  id: input.sourceId,
  workspaceId: input.workspaceId,
  name: input.name ?? "GitHub",
  kind: "openapi",
  endpoint: input.endpoint ?? "https://api.github.com",
  status: "connected",
  enabled: true,
  namespace: "github",
  bindingVersion: 1,
  binding: {
    specUrl: input.specUrl ?? "https://example.com/openapi.json",
    defaultHeaders: null,
  },
  importAuthPolicy: "reuse_runtime",
  importAuth: { kind: "none" },
  auth: input.auth,
  sourceHash: null,
  lastError: null,
  createdAt: input.now,
  updatedAt: input.updatedAt ?? input.now,
});

describe("source-store", () => {
  it.scoped("replaces superseded secrets and removes source auth state cleanly", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();
      const accountId = AccountIdSchema.make("acc_source_store");
      const organizationId = OrganizationIdSchema.make("org_source_store");
      const workspaceId = WorkspaceIdSchema.make("ws_source_store");
      const sourceId = SourceIdSchema.make("src_source_store");
      const firstTokenId = SecretMaterialIdSchema.make("sec_source_store_first");
      const secondTokenId = SecretMaterialIdSchema.make("sec_source_store_second");

      yield* persistence.rows.organizations.insert({
        id: organizationId,
        slug: "source-store",
        name: "Source Store",
        status: "active",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.workspaces.insert({
        id: workspaceId,
        organizationId,
        name: "Primary",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.secretMaterials.upsert({
        id: firstTokenId,
        name: null,
        purpose: "auth_material",
        value: "ghp_first",
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.secretMaterials.upsert({
        id: secondTokenId,
        name: null,
        purpose: "auth_material",
        value: "ghp_second",
        createdAt: now,
        updatedAt: now,
      });

      yield* persistSource(
        persistence.rows,
        makeOpenApiSource({
          workspaceId,
          sourceId,
          now,
          auth: {
            kind: "bearer",
            headerName: "Authorization",
            prefix: "Bearer ",
            token: {
              providerId: "postgres",
              handle: firstTokenId,
            },
          },
        }),
      );

      yield* persistence.rows.sourceAuthSessions.upsert({
        id: SourceAuthSessionIdSchema.make("src_auth_source_store"),
        workspaceId,
        sourceId,
        actorAccountId: accountId,
        executionId: null,
        interactionId: null,
        providerKind: "mcp_oauth",
        credentialSlot: "runtime",
        status: "pending",
        state: "state_source_store",
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

      yield* persistSource(
        persistence.rows,
        makeOpenApiSource({
          workspaceId,
          sourceId,
          now,
          updatedAt: now + 1,
          auth: {
            kind: "bearer",
            headerName: "Authorization",
            prefix: "Bearer ",
            token: {
              providerId: "postgres",
              handle: secondTokenId,
            },
          },
        }),
      );

      expect(Option.isNone(yield* persistence.rows.secretMaterials.getById(firstTokenId))).toBe(true);
      expect(yield* persistence.rows.credentials.listByWorkspaceId(workspaceId)).toHaveLength(1);
      expect((yield* persistence.rows.credentials.listByWorkspaceId(workspaceId))[0]?.tokenHandle).toBe(
        secondTokenId,
      );

      const removed = yield* removeSourceById(persistence.rows, {
        workspaceId,
        sourceId,
      });
      expect(removed).toBe(true);

      expect(Option.isNone(yield* persistence.rows.secretMaterials.getById(secondTokenId))).toBe(true);
      expect(yield* persistence.rows.sources.listByWorkspaceId(workspaceId)).toHaveLength(0);
      expect(yield* persistence.rows.credentials.listByWorkspaceId(workspaceId)).toHaveLength(0);
      expect(yield* persistence.rows.sourceAuthSessions.listByWorkspaceId(workspaceId)).toHaveLength(0);
    }),
  );

  it.scoped("creates a fresh actor-scoped credential when a shared credential already exists", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();
      const accountId = AccountIdSchema.make("acc_actor_scoped");
      const organizationId = OrganizationIdSchema.make("org_actor_scoped");
      const workspaceId = WorkspaceIdSchema.make("ws_actor_scoped");
      const sourceId = SourceIdSchema.make("src_actor_scoped");
      const sharedTokenId = SecretMaterialIdSchema.make("sec_actor_scoped_shared");

      yield* persistence.rows.organizations.insert({
        id: organizationId,
        slug: "actor-scoped",
        name: "Actor Scoped",
        status: "active",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.workspaces.insert({
        id: workspaceId,
        organizationId,
        name: "Primary",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.secretMaterials.upsert({
        id: sharedTokenId,
        name: null,
        purpose: "auth_material",
        value: "ghp_shared",
        createdAt: now,
        updatedAt: now,
      });

      const source = makeOpenApiSource({
        workspaceId,
        sourceId,
        now,
        auth: {
          kind: "bearer",
          headerName: "Authorization",
          prefix: "Bearer ",
          token: {
            providerId: "postgres",
            handle: sharedTokenId,
          },
        },
      });

      yield* persistSource(persistence.rows, source);
      yield* persistSource(
        persistence.rows,
        {
          ...source,
          updatedAt: now + 1,
        },
        {
          actorAccountId: accountId,
        },
      );

      const credentials = yield* persistence.rows.credentials.listByWorkspaceAndSourceId({
        workspaceId,
        sourceId,
      });
      expect(credentials).toHaveLength(2);
      expect(credentials.some((credential) => credential.actorAccountId === null)).toBe(true);
      expect(credentials.some((credential) => credential.actorAccountId === accountId)).toBe(true);
      expect(new Set(credentials.map((credential) => credential.id)).size).toBe(2);
    }),
  );

  it.scoped("cleans up orphaned recipe data when the source config changes", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();
      const accountId = AccountIdSchema.make("acc_recipe_rewrite");
      const organizationId = OrganizationIdSchema.make("org_recipe_rewrite");
      const workspaceId = WorkspaceIdSchema.make("ws_recipe_rewrite");
      const sourceId = SourceIdSchema.make("src_recipe_rewrite");

      yield* persistence.rows.organizations.insert({
        id: organizationId,
        slug: "recipe-rewrite",
        name: "Recipe Rewrite",
        status: "active",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.workspaces.insert({
        id: workspaceId,
        organizationId,
        name: "Primary",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });

      const initialSource = makeOpenApiSource({
        workspaceId,
        sourceId,
        now,
        auth: { kind: "none" },
      });
      const initialRecipeId = stableSourceRecipeId(initialSource);
      const initialRecipeRevisionId = stableSourceRecipeRevisionId(initialSource);

      yield* persistSource(persistence.rows, initialSource);
      yield* persistence.rows.sourceRecipeDocuments.replaceForRevision({
        recipeRevisionId: initialRecipeRevisionId,
        documents: [{
          id: "src_recipe_doc_recipe_rewrite",
          recipeRevisionId: initialRecipeRevisionId,
          documentKind: "openapi",
          documentKey:
            typeof initialSource.binding.specUrl === "string"
              ? initialSource.binding.specUrl
              : initialSource.endpoint,
          contentText: "{}",
          contentHash: "hash_recipe_rewrite",
          fetchedAt: now,
          createdAt: now,
          updatedAt: now,
        }],
      });
      yield* persistence.rows.sourceRecipeOperations.replaceForRevision({
        recipeRevisionId: initialRecipeRevisionId,
        operations: [{
          id: "src_recipe_op_recipe_rewrite",
          recipeRevisionId: initialRecipeRevisionId,
          operationKey: "getRepo",
          transportKind: "http",
          toolId: "getRepo",
          title: "Get Repo",
          description: "Read a repository",
          operationKind: "read",
          searchText: "github get repo",
          inputSchemaJson: null,
          outputSchemaJson: null,
          providerKind: "openapi",
          providerDataJson: JSON.stringify({
            kind: "openapi",
            toolId: "getRepo",
            rawToolId: "repos_getRepo",
            operationId: "repos.getRepo",
            group: "repos",
            leaf: "getRepo",
            tags: ["repos"],
            method: "get",
            path: "/repos/{owner}/{repo}",
            operationHash: "hash_recipe_rewrite",
            invocation: {
              method: "get",
              pathTemplate: "/repos/{owner}/{repo}",
              parameters: [],
              requestBody: null,
            },
          }),
          createdAt: now,
          updatedAt: now,
        }],
      });

      const updatedSource = makeOpenApiSource({
        workspaceId,
        sourceId,
        now,
        updatedAt: now + 1,
        endpoint: "https://api.example.com",
        specUrl: "https://api.example.com/openapi.json",
        auth: { kind: "none" },
      });
      const nextRecipeId = stableSourceRecipeId(updatedSource);
      const nextRecipeRevisionId = stableSourceRecipeRevisionId(updatedSource);

      yield* persistSource(persistence.rows, updatedSource);

      expect(Option.isNone(yield* persistence.rows.sourceRecipes.getById(initialRecipeId))).toBe(true);
      expect(
        Option.isNone(yield* persistence.rows.sourceRecipeRevisions.getById(initialRecipeRevisionId)),
      ).toBe(true);
      expect(
        yield* persistence.rows.sourceRecipeDocuments.listByRevisionId(initialRecipeRevisionId),
      ).toEqual([]);
      expect(
        yield* persistence.rows.sourceRecipeOperations.listByRevisionId(initialRecipeRevisionId),
      ).toEqual([]);
      expect(Option.isSome(yield* persistence.rows.sourceRecipes.getById(nextRecipeId))).toBe(true);
      expect(
        Option.isSome(yield* persistence.rows.sourceRecipeRevisions.getById(nextRecipeRevisionId)),
      ).toBe(true);
    }),
  );

  it.scoped("retains shared recipe data until the last source reference is removed", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();
      const accountId = AccountIdSchema.make("acc_shared_recipe");
      const organizationId = OrganizationIdSchema.make("org_shared_recipe");
      const workspaceId = WorkspaceIdSchema.make("ws_shared_recipe");
      const firstSourceId = SourceIdSchema.make("src_shared_recipe_one");
      const secondSourceId = SourceIdSchema.make("src_shared_recipe_two");

      yield* persistence.rows.organizations.insert({
        id: organizationId,
        slug: "shared-recipe",
        name: "Shared Recipe",
        status: "active",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.workspaces.insert({
        id: workspaceId,
        organizationId,
        name: "Primary",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });

      const firstSource = makeOpenApiSource({
        workspaceId,
        sourceId: firstSourceId,
        now,
        name: "GitHub One",
        auth: { kind: "none" },
      });
      const secondSource = makeOpenApiSource({
        workspaceId,
        sourceId: secondSourceId,
        now,
        updatedAt: now + 1,
        name: "GitHub Two",
        auth: { kind: "none" },
      });
      const sharedRecipeId = stableSourceRecipeId(firstSource);
      const sharedRecipeRevisionId = stableSourceRecipeRevisionId(firstSource);

      yield* persistSource(persistence.rows, firstSource);
      yield* persistSource(persistence.rows, secondSource);
      yield* persistence.rows.sourceRecipeDocuments.replaceForRevision({
        recipeRevisionId: sharedRecipeRevisionId,
        documents: [{
          id: "src_recipe_doc_shared_recipe",
          recipeRevisionId: sharedRecipeRevisionId,
          documentKind: "openapi",
          documentKey:
            typeof firstSource.binding.specUrl === "string"
              ? firstSource.binding.specUrl
              : firstSource.endpoint,
          contentText: "{}",
          contentHash: "hash_shared_recipe",
          fetchedAt: now,
          createdAt: now,
          updatedAt: now,
        }],
      });
      yield* persistence.rows.sourceRecipeOperations.replaceForRevision({
        recipeRevisionId: sharedRecipeRevisionId,
        operations: [{
          id: "src_recipe_op_shared_recipe",
          recipeRevisionId: sharedRecipeRevisionId,
          operationKey: "getRepo",
          transportKind: "http",
          toolId: "getRepo",
          title: "Get Repo",
          description: "Read a repository",
          operationKind: "read",
          searchText: "github get repo",
          inputSchemaJson: null,
          outputSchemaJson: null,
          providerKind: "openapi",
          providerDataJson: JSON.stringify({
            kind: "openapi",
            toolId: "getRepo",
            rawToolId: "repos_getRepo",
            operationId: "repos.getRepo",
            group: "repos",
            leaf: "getRepo",
            tags: ["repos"],
            method: "get",
            path: "/repos/{owner}/{repo}",
            operationHash: "hash_shared_recipe",
            invocation: {
              method: "get",
              pathTemplate: "/repos/{owner}/{repo}",
              parameters: [],
              requestBody: null,
            },
          }),
          createdAt: now,
          updatedAt: now,
        }],
      });

      yield* removeSourceById(persistence.rows, {
        workspaceId,
        sourceId: firstSourceId,
      });

      expect(Option.isSome(yield* persistence.rows.sourceRecipes.getById(sharedRecipeId))).toBe(true);
      expect(
        Option.isSome(yield* persistence.rows.sourceRecipeRevisions.getById(sharedRecipeRevisionId)),
      ).toBe(true);
      expect(
        yield* persistence.rows.sourceRecipeDocuments.listByRevisionId(sharedRecipeRevisionId),
      ).toHaveLength(1);
      expect(
        yield* persistence.rows.sourceRecipeOperations.listByRevisionId(sharedRecipeRevisionId),
      ).toHaveLength(1);

      yield* removeSourceById(persistence.rows, {
        workspaceId,
        sourceId: secondSourceId,
      });

      expect(Option.isNone(yield* persistence.rows.sourceRecipes.getById(sharedRecipeId))).toBe(true);
      expect(
        Option.isNone(yield* persistence.rows.sourceRecipeRevisions.getById(sharedRecipeRevisionId)),
      ).toBe(true);
      expect(
        yield* persistence.rows.sourceRecipeDocuments.listByRevisionId(sharedRecipeRevisionId),
      ).toEqual([]);
      expect(
        yield* persistence.rows.sourceRecipeOperations.listByRevisionId(sharedRecipeRevisionId),
      ).toEqual([]);
    }),
  );
});

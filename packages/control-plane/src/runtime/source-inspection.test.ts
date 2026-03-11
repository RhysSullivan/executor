import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import {
  AccountIdSchema,
  OrganizationIdSchema,
  SourceIdSchema,
  SourceRecipeIdSchema,
  SourceRecipeRevisionIdSchema,
  SourceRecipeSchemaBundleIdSchema,
  WorkspaceIdSchema,
  type Source,
  type StoredSourceRecipeOperationRecord,
} from "#schema";
import {
  createSqlControlPlanePersistence,
  type SqlControlPlanePersistence,
} from "#persistence";

import {
  getSourceInspection,
  getSourceInspectionSchemaBundle,
  getSourceInspectionToolDetail,
} from "./source-inspection";
import { ControlPlaneStore } from "./store";

const makePersistence = () =>
  Effect.runPromise(
    createSqlControlPlanePersistence({
      localDataDir: ":memory:",
    }),
  );

const seedWorkspace = async (input: {
  persistence: SqlControlPlanePersistence;
  workspaceId: ReturnType<typeof WorkspaceIdSchema.make>;
  organizationId: ReturnType<typeof OrganizationIdSchema.make>;
  accountId: ReturnType<typeof AccountIdSchema.make>;
}) => {
  await Effect.runPromise(input.persistence.rows.organizations.insert({
    id: input.organizationId,
    slug: `org-${input.organizationId}`,
    name: `Org ${input.organizationId}`,
    status: "active",
    createdByAccountId: input.accountId,
    createdAt: 1000,
    updatedAt: 1000,
  }));
  await Effect.runPromise(input.persistence.rows.workspaces.insert({
    id: input.workspaceId,
    organizationId: input.organizationId,
    name: `Workspace ${input.workspaceId}`,
    createdByAccountId: input.accountId,
    createdAt: 1000,
    updatedAt: 1000,
  }));
};

const makeSource = (input: {
  workspaceId: Source["workspaceId"];
  sourceId: Source["id"];
}): Source => ({
  id: input.sourceId,
  workspaceId: input.workspaceId,
  name: "Cloudflare API",
  kind: "openapi",
  endpoint: "https://api.cloudflare.com/client/v4",
  status: "connected",
  enabled: true,
  namespace: "cloudflare.api",
  bindingVersion: 1,
  binding: {
    specUrl: "https://example.com/openapi.json",
    defaultHeaders: null,
  },
  importAuthPolicy: "reuse_runtime",
  importAuth: { kind: "none" },
  auth: { kind: "none" },
  sourceHash: null,
  lastError: null,
  createdAt: 1000,
  updatedAt: 1000,
});

const makeOperation = (
  overrides: Partial<StoredSourceRecipeOperationRecord> = {},
): StoredSourceRecipeOperationRecord => ({
  id: "src_recipe_op_inspection",
  recipeRevisionId: SourceRecipeRevisionIdSchema.make("src_recipe_rev_inspection"),
  operationKey: "zones.listZones",
  transportKind: "http",
  toolId: "zones.listZones",
  title: "List zones",
  description: "List Cloudflare zones",
  operationKind: "read",
  searchText: "zones list cloudflare",
  inputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      page: { type: "number" },
    },
  }),
  outputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      result: {
        type: "array",
        items: { type: "string" },
      },
    },
  }),
  providerKind: "openapi",
  providerDataJson: JSON.stringify({
    kind: "openapi",
    toolId: "zones.listZones",
    rawToolId: "zones_listZones",
    operationId: "zones.listZones",
    group: "zones",
    leaf: "listZones",
    tags: ["zones"],
    method: "get",
    path: "/zones",
    operationHash: "hash",
    invocation: {
      method: "get",
      pathTemplate: "/zones",
      parameters: [],
      requestBody: null,
    },
  }),
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

describe("source-inspection", () => {
  it("returns a lightweight inspection bundle and loads rich detail on demand", async () => {
    const persistence = await makePersistence();
    try {
      const workspaceId = WorkspaceIdSchema.make("ws_source_inspection");
      const organizationId = OrganizationIdSchema.make("org_source_inspection");
      const accountId = AccountIdSchema.make("acc_source_inspection");
      const sourceId = SourceIdSchema.make("src_source_inspection");
      const recipeId = SourceRecipeIdSchema.make("src_recipe_inspection");
      const recipeRevisionId = SourceRecipeRevisionIdSchema.make("src_recipe_rev_inspection");
      const hugeDocument = JSON.stringify({
        openapi: "3.0.3",
        info: {
          title: "Cloudflare API",
          version: "1.0.0",
        },
        paths: Object.fromEntries(
          Array.from({ length: 256 }, (_, index) => [
            `/zones/${index}`,
            {
              get: {
                operationId: `zones.listZones${index}`,
                responses: { 200: { description: "ok" } },
              },
            },
          ]),
        ),
      });

      await seedWorkspace({
        persistence,
        workspaceId,
        organizationId,
        accountId,
      });
      await Effect.runPromise(persistence.rows.sourceRecipes.upsert({
        id: recipeId,
        kind: "http_api",
        adapterKey: "openapi",
        providerKey: "generic_http",
        name: "Cloudflare API",
        summary: null,
        visibility: "workspace",
        latestRevisionId: recipeRevisionId,
        createdAt: 1000,
        updatedAt: 1000,
      }));
      await Effect.runPromise(persistence.rows.sourceRecipeRevisions.upsert({
        id: recipeRevisionId,
        recipeId,
        revisionNumber: 1,
        sourceConfigJson: JSON.stringify({
          kind: "openapi",
          endpoint: "https://api.cloudflare.com/client/v4",
          specUrl: "https://example.com/openapi.json",
        }),
        manifestJson: JSON.stringify({
          sourceHash: "manifest_hash",
        }),
        manifestHash: "manifest_hash",
        materializationHash: "materialization_hash",
        createdAt: 1000,
        updatedAt: 1000,
      }));
      await Effect.runPromise(persistence.rows.sourceRecipeDocuments.replaceForRevision({
        recipeRevisionId,
        documents: [{
          id: "src_recipe_doc_inspection",
          recipeRevisionId,
          documentKind: "openapi",
          documentKey: "https://example.com/openapi.json",
          contentText: hugeDocument,
          contentHash: "doc_hash",
          fetchedAt: 1000,
          createdAt: 1000,
          updatedAt: 1000,
        }],
      }));
      await Effect.runPromise(persistence.rows.sourceRecipeSchemaBundles.replaceForRevision({
        recipeRevisionId,
        bundles: [{
          id: SourceRecipeSchemaBundleIdSchema.make("src_recipe_bundle_inspection"),
          recipeRevisionId,
          bundleKind: "json_schema_ref_map",
          refsJson: JSON.stringify({
            "#/components/schemas/Pagination": {
              type: "object",
              properties: {
                page: { type: "number" },
              },
            },
          }),
          contentHash: "bundle_hash",
          createdAt: 1000,
          updatedAt: 1000,
        }],
      }));
      await Effect.runPromise(persistence.rows.sourceRecipeOperations.replaceForRevision({
        recipeRevisionId,
        operations: [makeOperation()],
      }));
      await Effect.runPromise(persistence.rows.sources.insert({
        id: sourceId,
        workspaceId,
        recipeId,
        recipeRevisionId,
        name: "Cloudflare API",
        kind: "openapi",
        endpoint: "https://api.cloudflare.com/client/v4",
        status: "connected",
        enabled: true,
        namespace: "cloudflare.api",
        importAuthPolicy: "reuse_runtime",
        bindingConfigJson: JSON.stringify({
          adapterKey: "openapi",
          version: 1,
          payload: {
            specUrl: "https://example.com/openapi.json",
            defaultHeaders: null,
          },
        }),
        sourceHash: null,
        lastError: null,
        createdAt: 1000,
        updatedAt: 1000,
      }));

      const inspection = await Effect.runPromise(
        getSourceInspection({
          workspaceId,
          sourceId,
        }).pipe(
          Effect.provideService(ControlPlaneStore, persistence.rows),
        ),
      );

      expect(inspection.toolCount).toBe(1);
      expect(inspection.tools[0]?.path).toBe("cloudflare.api.zones.listZones");
      expect("manifestJson" in inspection).toBe(false);
      expect("rawDocumentText" in inspection).toBe(false);
      expect("definitionsJson" in inspection).toBe(false);

      const detail = await Effect.runPromise(
        getSourceInspectionToolDetail({
          workspaceId,
          sourceId,
          toolPath: "cloudflare.api.zones.listZones",
        }).pipe(
          Effect.provideService(ControlPlaneStore, persistence.rows),
        ),
      );

      expect(detail.summary.method).toBe("get");
      expect(detail.summary.inputType).toContain("page");
      expect(detail.summary.outputType).toContain("result");
      expect(detail.providerDataJson).toContain("/zones");
      expect(detail.inputSchemaJson).toContain("\"page\"");
      expect(detail.outputSchemaJson).toContain("\"result\"");
      expect(detail.schemaBundleId).toBe("src_recipe_bundle_inspection");

      const schemaBundle = await Effect.runPromise(
        getSourceInspectionSchemaBundle({
          workspaceId,
          sourceId,
          schemaBundleId: "src_recipe_bundle_inspection",
        }).pipe(
          Effect.provideService(ControlPlaneStore, persistence.rows),
        ),
      );

      expect(schemaBundle.kind).toBe("json_schema_ref_map");
      expect(schemaBundle.refsJson).toContain("Pagination");
    } finally {
      await persistence.close();
    }
  });
});

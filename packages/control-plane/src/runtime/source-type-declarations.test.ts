import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  SourceIdSchema,
  WorkspaceIdSchema,
  type Source,
} from "#schema";

import {
  createCatalogSnapshotV1,
  createEmptyCatalogV1,
} from "../ir/catalog";
import {
  CapabilityIdSchema,
  DocumentIdSchema,
  ExecutableIdSchema,
  ResourceIdSchema,
  ResponseSetIdSchema,
  ScopeIdSchema,
  ShapeSymbolIdSchema,
} from "../ir/ids";
import type { CatalogV1, GraphQLExecutable, ProvenanceRef } from "../ir/model";
import { syncWorkspaceSourceTypeDeclarationsNode } from "./source-type-declarations";

const put = <K extends string, V>(record: Record<K, V>, key: K, value: V) => {
  record[key] = value;
};

const docId = DocumentIdSchema.make("doc_graphql");
const baseProvenance = (pointer: string): ProvenanceRef[] => [{
  relation: "declared",
  documentId: docId,
  pointer,
}];

const createSnapshot = (): ReturnType<typeof createCatalogSnapshotV1> => {
  const catalog = createEmptyCatalogV1();
  const resourceId = ResourceIdSchema.make("res_graphql");
  const scopeId = ScopeIdSchema.make("scope_graphql");
  const stringShapeId = ShapeSymbolIdSchema.make("shape_string");
  const teamFilterShapeId = ShapeSymbolIdSchema.make("shape_team_filter");
  const callShapeId = ShapeSymbolIdSchema.make("shape_team_query_args");
  const resultShapeId = ShapeSymbolIdSchema.make("shape_team_connection");
  const executableId = ExecutableIdSchema.make("exec_graphql_teams");
  const capabilityId = CapabilityIdSchema.make("cap_graphql_teams");
  const responseSetId = ResponseSetIdSchema.make("response_set_graphql_teams");
  const secondExecutableId = ExecutableIdSchema.make("exec_graphql_teams_search");
  const secondCapabilityId = CapabilityIdSchema.make("cap_graphql_teams_search");

  put(catalog.documents as Record<typeof docId, CatalogV1["documents"][typeof docId]>, docId, {
    id: docId,
    kind: "graphql-schema",
    title: "Linear GraphQL",
    fetchedAt: "2026-03-14T00:00:00.000Z",
    rawRef: "memory://linear/graphql",
  });

  put(catalog.resources as Record<typeof resourceId, CatalogV1["resources"][typeof resourceId]>, resourceId, {
    id: resourceId,
    documentId: docId,
    canonicalUri: "https://api.linear.app/graphql",
    baseUri: "https://api.linear.app/graphql",
    anchors: {},
    dynamicAnchors: {},
    synthetic: false,
    provenance: baseProvenance("#"),
  });

  put(catalog.scopes as Record<typeof scopeId, CatalogV1["scopes"][typeof scopeId]>, scopeId, {
    id: scopeId,
    kind: "service",
    name: "Linear",
    namespace: "linear",
    synthetic: false,
    provenance: baseProvenance("#"),
  });

  put(catalog.symbols as Record<typeof stringShapeId, CatalogV1["symbols"][typeof stringShapeId]>, stringShapeId, {
    id: stringShapeId,
    kind: "shape",
    resourceId,
    title: "String",
    node: {
      type: "scalar",
      scalar: "string",
    },
    synthetic: false,
    provenance: baseProvenance("#/scalar/String"),
  });

  put(catalog.symbols as Record<typeof teamFilterShapeId, CatalogV1["symbols"][typeof teamFilterShapeId]>, teamFilterShapeId, {
    id: teamFilterShapeId,
    kind: "shape",
    resourceId,
    title: "shape_deadbeef",
    node: {
      type: "object",
      fields: {
        name: {
          shapeId: stringShapeId,
        },
      },
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/input/TeamFilter"),
  });

  put(catalog.symbols as Record<typeof callShapeId, CatalogV1["symbols"][typeof callShapeId]>, callShapeId, {
    id: callShapeId,
    kind: "shape",
    resourceId,
    title: "shape_feedface",
    node: {
      type: "object",
      fields: {
        filter: {
          shapeId: teamFilterShapeId,
        },
      },
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/query/teams/args"),
  });

  put(catalog.symbols as Record<typeof resultShapeId, CatalogV1["symbols"][typeof resultShapeId]>, resultShapeId, {
    id: resultShapeId,
    kind: "shape",
    resourceId,
    title: "TeamConnection",
    node: {
      type: "object",
      fields: {
        nodes: {
          shapeId: teamFilterShapeId,
        },
      },
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/query/teams/result"),
  });

  put(catalog.responseSets as Record<typeof responseSetId, CatalogV1["responseSets"][typeof responseSetId]>, responseSetId, {
    id: responseSetId,
    variants: [],
    synthetic: false,
    provenance: baseProvenance("#/responses"),
  });

  put(catalog.capabilities as Record<typeof capabilityId, CatalogV1["capabilities"][typeof capabilityId]>, capabilityId, {
    id: capabilityId,
    serviceScopeId: scopeId,
    surface: {
      toolPath: ["linear", "teams"],
      title: "Teams",
      summary: "List teams",
    },
    semantics: {
      effect: "read",
      safe: true,
      idempotent: true,
      destructive: false,
    },
    auth: { kind: "none" },
    interaction: {
      approval: { mayRequire: false },
      elicitation: { mayRequest: false },
      resume: { supported: false },
    },
    executableIds: [executableId],
    preferredExecutableId: executableId,
    synthetic: false,
    provenance: baseProvenance("#/query/teams"),
  });

  put(catalog.executables as Record<typeof executableId, CatalogV1["executables"][typeof executableId]>, executableId, {
    id: executableId,
    protocol: "graphql",
    capabilityId,
    scopeId,
    toolKind: "field",
    operationType: "query",
    rootField: "teams",
    argumentShapeId: callShapeId,
    resultShapeId,
    selectionMode: "fixed",
    responseSetId,
    synthetic: false,
    provenance: baseProvenance("#/query/teams"),
  });

  put(catalog.capabilities as Record<typeof secondCapabilityId, CatalogV1["capabilities"][typeof secondCapabilityId]>, secondCapabilityId, {
    id: secondCapabilityId,
    serviceScopeId: scopeId,
    surface: {
      toolPath: ["linear", "teamsSearch"],
      title: "Teams Search",
      summary: "Search teams",
    },
    semantics: {
      effect: "read",
      safe: true,
      idempotent: true,
      destructive: false,
    },
    auth: { kind: "none" },
    interaction: {
      approval: { mayRequire: false },
      elicitation: { mayRequest: false },
      resume: { supported: false },
    },
    executableIds: [secondExecutableId],
    preferredExecutableId: secondExecutableId,
    synthetic: false,
    provenance: baseProvenance("#/query/teamsSearch"),
  });

  put(catalog.executables as Record<typeof secondExecutableId, CatalogV1["executables"][typeof secondExecutableId]>, secondExecutableId, {
    id: secondExecutableId,
    protocol: "graphql",
    capabilityId: secondCapabilityId,
    scopeId,
    toolKind: "field",
    operationType: "query",
    rootField: "teamsSearch",
    argumentShapeId: callShapeId,
    resultShapeId,
    selectionMode: "fixed",
    responseSetId,
    synthetic: false,
    provenance: baseProvenance("#/query/teamsSearch"),
  });

  return createCatalogSnapshotV1({
    import: {
      sourceKind: "graphql-schema",
      adapterKey: "graphql",
      importerVersion: "test",
      importedAt: "2026-03-14T00:00:00.000Z",
      sourceConfigHash: "hash_test",
    },
    catalog,
  });
};

const makeSource = (input: {
  id: string;
  enabled?: boolean;
  status?: Source["status"];
}): Source => ({
  id: SourceIdSchema.make(input.id),
  workspaceId: WorkspaceIdSchema.make("ws_test"),
  name: input.id,
  kind: "graphql",
  endpoint: "https://api.linear.app/graphql",
  status: input.status ?? "connected",
  enabled: input.enabled ?? true,
  namespace: "linear",
  bindingVersion: 1,
  binding: {
    defaultHeaders: null,
  },
  importAuthPolicy: "reuse_runtime",
  importAuth: { kind: "none" },
  auth: { kind: "none" },
  sourceHash: "hash_test",
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
});

describe("source-type-declarations", () => {
  it("writes per-source and aggregate declaration files", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "executor-types-"));
    const context = {
      cwd: workspaceRoot,
      workspaceRoot,
      workspaceName: "executor-types",
      configDirectory: join(workspaceRoot, ".executor"),
      projectConfigPath: join(workspaceRoot, ".executor", "executor.jsonc"),
      homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
      artifactsDirectory: join(workspaceRoot, ".executor", "artifacts"),
      stateDirectory: join(workspaceRoot, ".executor", "state"),
    };

    const snapshot = createSnapshot();
    await Effect.runPromise(syncWorkspaceSourceTypeDeclarationsNode({
      context,
      entries: [
        {
          source: makeSource({ id: "src_linear" }),
          snapshot,
        },
        {
          source: makeSource({ id: "src_hidden", enabled: false }),
          snapshot,
        },
      ],
    }));

    const sourceDeclaration = readFileSync(
      join(workspaceRoot, ".executor", "types", "sources", "src_linear.d.ts"),
      "utf8",
    );
    const aggregateDeclaration = readFileSync(
      join(workspaceRoot, ".executor", "types", "index.d.ts"),
      "utf8",
    );

    expect(sourceDeclaration).toContain("export interface SourceTools_src_linear");
    expect(sourceDeclaration).toContain("type LinearTeamsCall = {");
    expect(sourceDeclaration).toContain("type LinearTeamsResult = {");
    expect(sourceDeclaration.match(/type LinearTeamsCall =/g)?.length).toBe(1);
    expect(sourceDeclaration).not.toContain("type shape_");
    expect(sourceDeclaration).not.toContain("= shape_");
    expect(sourceDeclaration).toContain("linear: {");
    expect(sourceDeclaration).toContain("teams: (args?: LinearTeamsCall) => Promise<LinearTeamsResult>;");
    expect(sourceDeclaration).toContain("teamsSearch: (args?: LinearTeamsCall) => Promise<LinearTeamsResult>;");
    expect(sourceDeclaration).not.toMatch(/type\s+[0-9]/);
    expect(aggregateDeclaration).toContain('import type { SourceTools_src_linear } from "./sources/src_linear";');
    expect(aggregateDeclaration).not.toContain("src_hidden");
    expect(aggregateDeclaration).toContain("declare global {");
    expect(aggregateDeclaration).toContain("const tools: ExecutorSourceTools;");
  });

  it("removes stale source declarations when the source disappears", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "executor-types-stale-"));
    const context = {
      cwd: workspaceRoot,
      workspaceRoot,
      workspaceName: "executor-types-stale",
      configDirectory: join(workspaceRoot, ".executor"),
      projectConfigPath: join(workspaceRoot, ".executor", "executor.jsonc"),
      homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
      artifactsDirectory: join(workspaceRoot, ".executor", "artifacts"),
      stateDirectory: join(workspaceRoot, ".executor", "state"),
    };

    const snapshot = createSnapshot();
    await Effect.runPromise(syncWorkspaceSourceTypeDeclarationsNode({
      context,
      entries: [{ source: makeSource({ id: "src_linear" }), snapshot }],
    }));
    await Effect.runPromise(syncWorkspaceSourceTypeDeclarationsNode({
      context,
      entries: [],
    }));

    const aggregateDeclaration = readFileSync(
      join(workspaceRoot, ".executor", "types", "index.d.ts"),
      "utf8",
    );

    expect(aggregateDeclaration).toContain("export type ExecutorSourceTools = {};");
    expect(() =>
      readFileSync(
        join(workspaceRoot, ".executor", "types", "sources", "src_linear.d.ts"),
        "utf8",
      )
    ).toThrow();
  });

  it("falls back to unknown for unsupported declaration-only shape nodes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "executor-types-unsupported-"));
    const context = {
      cwd: workspaceRoot,
      workspaceRoot,
      workspaceName: "executor-types-unsupported",
      configDirectory: join(workspaceRoot, ".executor"),
      projectConfigPath: join(workspaceRoot, ".executor", "executor.jsonc"),
      homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
      artifactsDirectory: join(workspaceRoot, ".executor", "artifacts"),
      stateDirectory: join(workspaceRoot, ".executor", "state"),
    };

    const snapshot = createSnapshot();
    const unsupportedNotShapeId = ShapeSymbolIdSchema.make("shape_unsupported_not");
    const unsupportedConditionalShapeId = ShapeSymbolIdSchema.make("shape_unsupported_conditional");
    const executable = Object.values(snapshot.catalog.executables)[0]! as GraphQLExecutable;
    const callShape = snapshot.catalog.symbols[executable.argumentShapeId];
    const resultShape = snapshot.catalog.symbols[executable.resultShapeId];

    if (!callShape || callShape.kind !== "shape" || callShape.node.type !== "object") {
      throw new Error("Expected object argument shape in test fixture");
    }

    if (!resultShape || resultShape.kind !== "shape" || resultShape.node.type !== "object") {
      throw new Error("Expected object result shape in test fixture");
    }

    put(
      snapshot.catalog.symbols as Record<typeof unsupportedNotShapeId, CatalogV1["symbols"][typeof unsupportedNotShapeId]>,
      unsupportedNotShapeId,
      {
        id: unsupportedNotShapeId,
        kind: "shape",
        title: "UnsupportedNot",
        node: {
          type: "not",
          itemShapeId: callShape.node.fields.filter!.shapeId,
        },
        synthetic: false,
        provenance: baseProvenance("#/unsupported/not"),
      },
    );

    put(
      snapshot.catalog.symbols as Record<
        typeof unsupportedConditionalShapeId,
        CatalogV1["symbols"][typeof unsupportedConditionalShapeId]
      >,
      unsupportedConditionalShapeId,
      {
        id: unsupportedConditionalShapeId,
        kind: "shape",
        title: "UnsupportedConditional",
        node: {
          type: "conditional",
          ifShapeId: callShape.node.fields.filter!.shapeId,
          thenShapeId: resultShape.node.fields.nodes!.shapeId,
          elseShapeId: executable.resultShapeId,
        },
        synthetic: false,
        provenance: baseProvenance("#/unsupported/conditional"),
      },
    );

    put(
      snapshot.catalog.symbols as Record<typeof callShape.id, CatalogV1["symbols"][typeof callShape.id]>,
      callShape.id,
      {
        ...callShape,
        node: {
          ...callShape.node,
          fields: {
            ...callShape.node.fields,
            unsupportedNot: {
              shapeId: unsupportedNotShapeId,
            },
          },
        },
      },
    );

    put(
      snapshot.catalog.symbols as Record<typeof resultShape.id, CatalogV1["symbols"][typeof resultShape.id]>,
      resultShape.id,
      {
        ...resultShape,
        node: {
          ...resultShape.node,
          fields: {
            ...resultShape.node.fields,
            unsupportedConditional: {
              shapeId: unsupportedConditionalShapeId,
            },
          },
        },
      },
    );

    await Effect.runPromise(syncWorkspaceSourceTypeDeclarationsNode({
      context,
      entries: [{ source: makeSource({ id: "src_linear" }), snapshot }],
    }));

    const sourceDeclaration = readFileSync(
      join(workspaceRoot, ".executor", "types", "sources", "src_linear.d.ts"),
      "utf8",
    );

    expect(sourceDeclaration).toContain("unsupportedNot?: unknown;");
    expect(sourceDeclaration).toContain("unsupportedConditional?: unknown;");
  });

  it("renders object unions as discriminated unions with shared fields", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "executor-types-union-"));
    const context = {
      cwd: workspaceRoot,
      workspaceRoot,
      workspaceName: "executor-types-union",
      configDirectory: join(workspaceRoot, ".executor"),
      projectConfigPath: join(workspaceRoot, ".executor", "executor.jsonc"),
      homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
      artifactsDirectory: join(workspaceRoot, ".executor", "artifacts"),
      stateDirectory: join(workspaceRoot, ".executor", "state"),
    };

    const snapshot = createSnapshot();
    const numberShapeId = ShapeSymbolIdSchema.make("shape_number");
    const blockedActionShapeId = ShapeSymbolIdSchema.make("shape_action_blocked");
    const unblockedActionShapeId = ShapeSymbolIdSchema.make("shape_action_unblocked");
    const routeBlockedActionShapeId = ShapeSymbolIdSchema.make("shape_action_route_blocked");
    const routeShapeId = ShapeSymbolIdSchema.make("shape_route");
    const blockedShapeId = ShapeSymbolIdSchema.make("shape_abuse_blocked");
    const unblockedShapeId = ShapeSymbolIdSchema.make("shape_abuse_unblocked");
    const routeBlockedShapeId = ShapeSymbolIdSchema.make("shape_abuse_route_blocked");
    const unionShapeId = ShapeSymbolIdSchema.make("shape_abuse_union");
    const executable = Object.values(snapshot.catalog.executables)[0]! as GraphQLExecutable;
    const stringShapeId = ShapeSymbolIdSchema.make("shape_string");

    put(snapshot.catalog.symbols as Record<typeof numberShapeId, CatalogV1["symbols"][typeof numberShapeId]>, numberShapeId, {
      id: numberShapeId,
      kind: "shape",
      title: "Number",
      node: {
        type: "scalar",
        scalar: "number",
      },
      synthetic: false,
      provenance: baseProvenance("#/scalar/Number"),
    });

    for (const [shapeId, action] of [
      [blockedActionShapeId, "blocked"],
      [unblockedActionShapeId, "unblocked"],
      [routeBlockedActionShapeId, "route-blocked"],
    ] as const) {
      put(snapshot.catalog.symbols as Record<typeof shapeId, CatalogV1["symbols"][typeof shapeId]>, shapeId, {
        id: shapeId,
        kind: "shape",
        title: String(action),
        node: {
          type: "const",
          value: action,
        },
        synthetic: false,
        provenance: baseProvenance(`#/const/${action}`),
      });
    }

    put(snapshot.catalog.symbols as Record<typeof routeShapeId, CatalogV1["symbols"][typeof routeShapeId]>, routeShapeId, {
      id: routeShapeId,
      kind: "shape",
      title: "RouteInfo",
      node: {
        type: "object",
        fields: {
          source: {
            shapeId: stringShapeId,
          },
        },
        required: ["source"],
        additionalProperties: false,
      },
      synthetic: false,
      provenance: baseProvenance("#/route"),
    });

    put(snapshot.catalog.symbols as Record<typeof blockedShapeId, CatalogV1["symbols"][typeof blockedShapeId]>, blockedShapeId, {
      id: blockedShapeId,
      kind: "shape",
      title: "BlockedHistoryItem",
      node: {
        type: "object",
        fields: {
          action: { shapeId: blockedActionShapeId },
          actor: { shapeId: stringShapeId },
          createdAt: { shapeId: numberShapeId },
          reason: { shapeId: stringShapeId },
          statusCode: { shapeId: numberShapeId },
        },
        required: ["action", "createdAt", "reason", "statusCode"],
        additionalProperties: false,
      },
      synthetic: false,
      provenance: baseProvenance("#/blocked"),
    });

    put(snapshot.catalog.symbols as Record<typeof unblockedShapeId, CatalogV1["symbols"][typeof unblockedShapeId]>, unblockedShapeId, {
      id: unblockedShapeId,
      kind: "shape",
      title: "UnblockedHistoryItem",
      node: {
        type: "object",
        fields: {
          action: { shapeId: unblockedActionShapeId },
          actor: { shapeId: stringShapeId },
          createdAt: { shapeId: numberShapeId },
        },
        required: ["action", "createdAt"],
        additionalProperties: false,
      },
      synthetic: false,
      provenance: baseProvenance("#/unblocked"),
    });

    put(snapshot.catalog.symbols as Record<typeof routeBlockedShapeId, CatalogV1["symbols"][typeof routeBlockedShapeId]>, routeBlockedShapeId, {
      id: routeBlockedShapeId,
      kind: "shape",
      title: "RouteBlockedHistoryItem",
      node: {
        type: "object",
        fields: {
          action: { shapeId: routeBlockedActionShapeId },
          actor: { shapeId: stringShapeId },
          createdAt: { shapeId: numberShapeId },
          reason: { shapeId: stringShapeId },
          route: { shapeId: routeShapeId },
        },
        required: ["action", "createdAt", "reason", "route"],
        additionalProperties: false,
      },
      synthetic: false,
      provenance: baseProvenance("#/routeBlocked"),
    });

    put(snapshot.catalog.symbols as Record<typeof unionShapeId, CatalogV1["symbols"][typeof unionShapeId]>, unionShapeId, {
      id: unionShapeId,
      kind: "shape",
      title: "AbuseBlockHistoryItem",
      node: {
        type: "oneOf",
        items: [blockedShapeId, unblockedShapeId, routeBlockedShapeId],
      },
      synthetic: false,
      provenance: baseProvenance("#/union"),
    });

    put(snapshot.catalog.executables as Record<typeof executable.id, CatalogV1["executables"][typeof executable.id]>, executable.id, {
      ...executable,
      resultShapeId: unionShapeId,
    });

    await Effect.runPromise(syncWorkspaceSourceTypeDeclarationsNode({
      context,
      entries: [{ source: makeSource({ id: "src_linear" }), snapshot }],
    }));

    const sourceDeclaration = readFileSync(
      join(workspaceRoot, ".executor", "types", "sources", "src_linear.d.ts"),
      "utf8",
    );

    expect(sourceDeclaration).toContain("teams: (args?: LinearTeamsCall) => Promise<{");
    expect(sourceDeclaration).toContain("actor?: string;");
    expect(sourceDeclaration).toContain('action: "blocked";');
    expect(sourceDeclaration).toContain('action: "unblocked";');
    expect(sourceDeclaration).toContain('action: "route-blocked";');
    expect(sourceDeclaration).toContain("} & (");
    expect(sourceDeclaration).not.toContain("Member2");
  });
});

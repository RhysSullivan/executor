import {
  type ToolCatalogEntry,
  type ToolDescriptor as CatalogToolDescriptor,
} from "@executor/codemode-core";
import type {
  AccountId,
  Source,
  StoredSourceRecord,
  StoredSourceCatalogRevisionRecord,
  WorkspaceId,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";

import {
  decodeCatalogSnapshotV1,
  projectCatalogForAgentSdk,
  type ProjectedCatalog,
} from "../ir/catalog";
import type {
  Capability,
  CatalogSnapshotV1,
  CatalogV1,
  Executable,
  GraphQLExecutable,
  HttpExecutable,
  McpExecutable,
  ShapeSymbol,
  Symbol as IrSymbol,
} from "../ir/model";
import { LocalSourceArtifactMissingError } from "./local-errors";
import {
  createCatalogTypeProjector,
  joinTypeNameSegments,
  projectedCatalogTypeRoots,
  type CatalogTypeProjector,
} from "./catalog-typescript";
import {
  RuntimeLocalWorkspaceService,
  type RuntimeLocalWorkspaceState,
} from "./local-runtime-context";
import type { LocalSourceArtifact } from "./local-source-artifacts";
import {
  SourceArtifactStore,
  type SourceArtifactStoreShape,
} from "./local-storage";
import { namespaceFromSourceName } from "./source-names";
import {
  RuntimeSourceStoreService,
  type RuntimeSourceStore,
} from "./source-store";

type CatalogImportMetadata = CatalogSnapshotV1["import"];

type ProjectedToolDescriptor = ProjectedCatalog["toolDescriptors"][keyof ProjectedCatalog["toolDescriptors"]];

export type LoadedSourceCatalog = {
  source: Source;
  sourceRecord: StoredSourceRecord;
  revision: StoredSourceCatalogRevisionRecord;
  snapshot: CatalogSnapshotV1;
  catalog: CatalogV1;
  projected: ProjectedCatalog;
  typeProjector: CatalogTypeProjector;
  importMetadata: CatalogImportMetadata;
};

export type LoadedSourceCatalogTool = {
  path: string;
  searchNamespace: string;
  searchText: string;
  source: Source;
  sourceRecord: StoredSourceRecord;
  revision: StoredSourceCatalogRevisionRecord;
  capabilityId: keyof CatalogV1["capabilities"];
  executableId: keyof CatalogV1["executables"];
  capability: Capability;
  executable: Executable;
  projectedDescriptor: ProjectedToolDescriptor;
  descriptor: CatalogToolDescriptor;
  projectedCatalog: CatalogV1;
  typeProjector: CatalogTypeProjector;
};

export type LoadedSourceCatalogToolIndexEntry = Omit<
  LoadedSourceCatalogTool,
  "revision" | "projectedDescriptor" | "typeProjector"
>;

export const catalogToolCatalogEntry = (input: {
  tool: LoadedSourceCatalogToolIndexEntry;
  score: (queryTokens: readonly string[]) => number;
}): ToolCatalogEntry => ({
  descriptor: input.tool.descriptor,
  namespace: input.tool.searchNamespace,
  searchText: input.tool.searchText,
  score: input.score,
});

const catalogNamespaceFromPath = (path: string): string => {
  const [first, second] = path.split(".");
  return second ? `${first}.${second}` : first;
};

const descriptorPath = (descriptor: CatalogToolDescriptor): string => descriptor.path;

const projectedToolPath = (projected: ProjectedCatalog, capability: Capability): string =>
  projected.toolDescriptors[capability.id]?.toolPath.join(".") ?? "";

const chooseExecutable = (catalog: CatalogV1, capability: Capability): Executable => {
  const preferred =
    capability.preferredExecutableId !== undefined
      ? catalog.executables[capability.preferredExecutableId]
      : undefined;
  if (preferred) {
    return preferred;
  }

  const first = capability.executableIds
    .map((id) => catalog.executables[id])
    .find((entry): entry is Executable => entry !== undefined);
  if (!first) {
    throw new Error(`Capability ${capability.id} has no executable`);
  }
  return first;
};

const asShape = (catalog: CatalogV1, shapeId: string | undefined): ShapeSymbol | undefined => {
  if (!shapeId) {
    return undefined;
  }

  const symbol = catalog.symbols[shapeId];
  return symbol?.kind === "shape" ? symbol : undefined;
};

const asJsonRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const symbolDocsSummary = (symbol: IrSymbol | undefined): string | undefined => {
  if (!symbol || !("docs" in symbol)) {
    return undefined;
  }

  return symbol.docs?.summary ?? symbol.docs?.description;
};

export const shapeToJsonSchema = (catalog: CatalogV1, rootShapeId: string): unknown => {
  const defs: Record<string, unknown> = {};
  const inlineStack = new Set<string>();
  const buildingDefs = new Set<string>();
  const builtDefs = new Set<string>();
  const defNameByShapeId = new Map<string, string>();
  const usedDefNames = new Set<string>();

  const sanitizeDefName = (value: string): string | null => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const sanitized = trimmed
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (sanitized.length === 0) {
      return null;
    }

    return /^[A-Za-z_]/.test(sanitized) ? sanitized : `shape_${sanitized}`;
  };

  const shapeLabelCandidates = (shapeId: string, suggestions: readonly string[]): string[] => {
    const shape = asShape(catalog, shapeId);
    return [
      ...suggestions,
      shape?.title,
      shapeId,
    ].flatMap((candidate) =>
      typeof candidate === "string" && candidate.trim().length > 0
        ? [candidate]
        : [],
    );
  };

  const defNameFor = (shapeId: string, suggestions: readonly string[]): string => {
    const existing = defNameByShapeId.get(shapeId);
    if (existing) {
      return existing;
    }

    const candidates = shapeLabelCandidates(shapeId, suggestions);
    for (const candidate of candidates) {
      const sanitized = sanitizeDefName(candidate);
      if (!sanitized) {
        continue;
      }

      if (!usedDefNames.has(sanitized)) {
        defNameByShapeId.set(shapeId, sanitized);
        usedDefNames.add(sanitized);
        return sanitized;
      }
    }

    const fallbackBase = sanitizeDefName(shapeId) ?? "shape";
    let fallback = fallbackBase;
    let index = 2;
    while (usedDefNames.has(fallback)) {
      fallback = `${fallbackBase}_${String(index)}`;
      index += 1;
    }

    defNameByShapeId.set(shapeId, fallback);
    usedDefNames.add(fallback);
    return fallback;
  };

  const primaryLabel = (shapeId: string, suggestions: readonly string[], fallback: string): string =>
    shapeLabelCandidates(shapeId, suggestions)[0] ?? fallback;

  const isShallowInlineCandidate = (
    shapeId: string,
    depth: number,
    seen: ReadonlySet<string>,
  ): boolean => {
    const shape = asShape(catalog, shapeId);
    if (!shape) {
      return true;
    }

    if (depth < 0 || seen.has(shapeId)) {
      return false;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(shapeId);

    return Match.value(shape.node).pipe(
      Match.when({ type: "unknown" }, () => true),
      Match.when({ type: "const" }, () => true),
      Match.when({ type: "enum" }, () => true),
      Match.when({ type: "scalar" }, () => true),
      Match.when({ type: "ref" }, (node) =>
        isShallowInlineCandidate(node.target, depth, nextSeen)),
      Match.when({ type: "nullable" }, (node) =>
        isShallowInlineCandidate(node.itemShapeId, depth - 1, nextSeen)),
      Match.when({ type: "array" }, (node) =>
        isShallowInlineCandidate(node.itemShapeId, depth - 1, nextSeen)),
      Match.when({ type: "object" }, (node) => {
        const fields = Object.values(node.fields);
        return fields.length <= 8
          && fields.every((field) =>
            isShallowInlineCandidate(field.shapeId, depth - 1, nextSeen));
      }),
      Match.orElse(() => false),
    );
  };

  const shouldInlineRefTarget = (shapeId: string): boolean =>
    isShallowInlineCandidate(shapeId, 2, new Set<string>());

  const buildInline = (
    shapeId: string,
    suggestions: readonly string[] = [],
  ): Record<string, unknown> => {
    if (inlineStack.has(shapeId)) {
      return buildRef(shapeId, suggestions);
    }

    const shape = asShape(catalog, shapeId);
    if (!shape) {
      return {};
    }

    inlineStack.add(shapeId);
    try {
      return buildSchema(shapeId, suggestions);
    } finally {
      inlineStack.delete(shapeId);
    }
  };

  const buildRef = (
    shapeId: string,
    suggestions: readonly string[] = [],
  ): { $ref: string } => {
    const defName = defNameFor(shapeId, suggestions);
    if (builtDefs.has(shapeId) || buildingDefs.has(shapeId)) {
      return { $ref: `#/$defs/${defName}` };
    }

    const shape = asShape(catalog, shapeId);
    buildingDefs.add(shapeId);
    const alreadyInline = inlineStack.has(shapeId);
    if (!alreadyInline) {
      inlineStack.add(shapeId);
    }

    try {
      defs[defName] = shape
        ? buildSchema(shapeId, suggestions)
        : {};
      builtDefs.add(shapeId);
    } finally {
      buildingDefs.delete(shapeId);
      if (!alreadyInline) {
        inlineStack.delete(shapeId);
      }
    }

    return { $ref: `#/$defs/${defName}` };
  };

  const buildSchema = (
    shapeId: string,
    suggestions: readonly string[] = [],
  ): Record<string, unknown> => {
    const shape = asShape(catalog, shapeId);
    if (!shape) {
      return {};
    }

    const label = primaryLabel(shapeId, suggestions, "shape");
    const withDocs = (schemaValue: Record<string, unknown>): Record<string, unknown> => ({
      ...(shape.title ? { title: shape.title } : {}),
      ...(shape.docs?.description ? { description: shape.docs.description } : {}),
      ...schemaValue,
    });

    return Match.value(shape.node).pipe(
      Match.when({ type: "unknown" }, () => withDocs({})),
      Match.when({ type: "const" }, (node) => withDocs({ const: node.value })),
      Match.when({ type: "enum" }, (node) => withDocs({ enum: node.values })),
      Match.when({ type: "scalar" }, (node) =>
        withDocs({
          type: node.scalar === "bytes" ? "string" : node.scalar,
          ...(node.scalar === "bytes" ? { format: "binary" } : {}),
          ...(node.format ? { format: node.format } : {}),
          ...(node.constraints ?? {}),
        })),
      Match.when({ type: "ref" }, (node) =>
        shouldInlineRefTarget(node.target)
          ? buildInline(node.target, suggestions)
          : buildRef(node.target, suggestions)),
      Match.when({ type: "nullable" }, (node) =>
        withDocs({
          anyOf: [
            buildInline(node.itemShapeId, suggestions),
            { type: "null" },
          ],
        })),
      Match.when({ type: "allOf" }, (node) =>
        withDocs({
          allOf: node.items.map((entry, index) =>
            buildInline(entry, [`${label}_allOf_${String(index + 1)}`])),
        })),
      Match.when({ type: "anyOf" }, (node) =>
        withDocs({
          anyOf: node.items.map((entry, index) =>
            buildInline(entry, [`${label}_anyOf_${String(index + 1)}`])),
        })),
      Match.when({ type: "oneOf" }, (node) =>
        withDocs({
          oneOf: node.items.map((entry, index) =>
            buildInline(entry, [`${label}_option_${String(index + 1)}`])),
          ...(node.discriminator
            ? {
                discriminator: {
                  propertyName: node.discriminator.propertyName,
                  ...(node.discriminator.mapping
                    ? {
                        mapping: Object.fromEntries(
                          Object.entries(node.discriminator.mapping).map(([key, value]) => [
                            key,
                            buildRef(value, [key, `${label}_${key}`]).$ref,
                          ]),
                        ),
                      }
                    : {}),
                },
              }
            : {}),
        })),
      Match.when({ type: "not" }, (node) =>
        withDocs({
          not: buildInline(node.itemShapeId, [`${label}_not`]),
        })),
      Match.when({ type: "conditional" }, (node) =>
        withDocs({
          if: buildInline(node.ifShapeId, [`${label}_if`]),
          ...(node.thenShapeId
            ? { then: buildInline(node.thenShapeId, [`${label}_then`]) }
            : {}),
          ...(node.elseShapeId
            ? { else: buildInline(node.elseShapeId, [`${label}_else`]) }
            : {}),
        })),
      Match.when({ type: "array" }, (node) =>
        withDocs({
          type: "array",
          items: buildInline(node.itemShapeId, [`${label}_item`]),
          ...(node.minItems !== undefined ? { minItems: node.minItems } : {}),
          ...(node.maxItems !== undefined ? { maxItems: node.maxItems } : {}),
        })),
      Match.when({ type: "tuple" }, (node) =>
        withDocs({
          type: "array",
          prefixItems: node.itemShapeIds.map((entry, index) =>
            buildInline(entry, [`${label}_item_${String(index + 1)}`])),
          ...(node.additionalItems !== undefined
            ? {
                items:
                  typeof node.additionalItems === "boolean"
                    ? node.additionalItems
                    : buildInline(node.additionalItems, [`${label}_item_rest`]),
              }
            : {}),
        })),
      Match.when({ type: "map" }, (node) =>
        withDocs({
          type: "object",
          additionalProperties: buildInline(node.valueShapeId, [`${label}_value`]),
        })),
      Match.when({ type: "object" }, (node) =>
        withDocs({
          type: "object",
          properties: Object.fromEntries(
            Object.entries(node.fields).map(([key, field]) => [
              key,
              {
                ...buildInline(field.shapeId, [key]),
                ...(field.docs?.description ? { description: field.docs.description } : {}),
              },
            ]),
          ),
          ...(node.required && node.required.length > 0
            ? { required: node.required }
            : {}),
          ...(node.additionalProperties !== undefined
            ? {
                additionalProperties:
                  typeof node.additionalProperties === "boolean"
                    ? node.additionalProperties
                    : buildInline(node.additionalProperties, [`${label}_additionalProperty`]),
              }
            : {}),
          ...(node.patternProperties
            ? {
                patternProperties: Object.fromEntries(
                  Object.entries(node.patternProperties).map(([key, value]) => [
                    key,
                    buildInline(value, [`${label}_patternProperty`]),
                  ]),
                ),
              }
            : {}),
        })),
      Match.when({ type: "graphqlInterface" }, (node) =>
        withDocs({
          type: "object",
          properties: Object.fromEntries(
            Object.entries(node.fields).map(([key, field]) => [
              key,
              buildInline(field.shapeId, [key]),
            ]),
          ),
        })),
      Match.when({ type: "graphqlUnion" }, (node) =>
        withDocs({
          oneOf: node.memberTypeIds.map((entry, index) =>
            buildInline(entry, [`${label}_member_${String(index + 1)}`])),
        })),
      Match.exhaustive,
    );
  };

  const buildRootSchema = (
    shapeId: string,
    suggestions: readonly string[] = [],
  ): Record<string, unknown> => {
    const shape = asShape(catalog, shapeId);
    if (!shape) {
      return {};
    }

    return Match.value(shape.node).pipe(
      Match.when({ type: "ref" }, (node) => buildRootSchema(node.target, suggestions)),
      Match.orElse(() => buildInline(shapeId, suggestions)),
    );
  };

  const rootSchema = buildRootSchema(rootShapeId, ["input"]);
  return Object.keys(defs).length > 0
    ? {
        ...rootSchema,
        $defs: defs,
      }
    : rootSchema;
};

const graphqlErrorItemSchema = (): Record<string, unknown> => ({
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "GraphQL error message.",
    },
    path: {
      type: "array",
      description: "Path to the field that produced the error.",
      items: {
        anyOf: [
          { type: "string" },
          { type: "number" },
        ],
      },
    },
    locations: {
      type: "array",
      description: "Source locations for the error in the GraphQL document.",
      items: {
        type: "object",
        properties: {
          line: { type: "number" },
          column: { type: "number" },
        },
        required: ["line", "column"],
        additionalProperties: false,
      },
    },
    extensions: {
      type: "object",
      description: "Additional provider-specific GraphQL error metadata.",
      additionalProperties: true,
    },
  },
  required: ["message"],
  additionalProperties: true,
});

const projectorForProjectedCatalog = (projected: ProjectedCatalog): CatalogTypeProjector =>
  createCatalogTypeProjector({
    catalog: projected.catalog,
    roots: projectedCatalogTypeRoots(projected),
  });

const applyGraphqlSchemaHints = (executable: Executable, schema: unknown): unknown => {
  if (executable.protocol !== "graphql") {
    return schema;
  }

  const root = asJsonRecord(schema);
  const properties = asJsonRecord(root.properties);
  const errors = asJsonRecord(properties.errors);
  const errorItems = asJsonRecord(errors.items);

  if (errors.type !== "array" || Object.keys(errorItems).length > 0) {
    return schema;
  }

  return {
    ...root,
    properties: {
      ...properties,
      errors: {
        ...errors,
        items: graphqlErrorItemSchema(),
      },
    },
  };
};

const codemodeDescriptorFromCapability = (input: {
  source: Source;
  projected: ProjectedCatalog;
  capability: Capability;
  executable: Executable;
  typeProjector: CatalogTypeProjector;
  includeSchemas: boolean;
}): CatalogToolDescriptor => {
  const projectedDescriptor = input.projected.toolDescriptors[input.capability.id];
  const path = projectedDescriptor.toolPath.join(".");
  const interaction =
    projectedDescriptor.interaction.mayRequireApproval || projectedDescriptor.interaction.mayElicit
      ? "required"
      : "auto";
  const inputSchema = input.includeSchemas
    ? shapeToJsonSchema(input.projected.catalog, projectedDescriptor.callShapeId)
    : undefined;
  const rawOutputSchema =
    input.includeSchemas && projectedDescriptor.resultShapeId
      ? shapeToJsonSchema(input.projected.catalog, projectedDescriptor.resultShapeId)
      : undefined;
  const outputSchema =
    rawOutputSchema === undefined
      ? undefined
      : applyGraphqlSchemaHints(input.executable, rawOutputSchema);
  const inputTypePreview = input.typeProjector.renderSelfContainedShape(
    projectedDescriptor.callShapeId,
    {
      aliasHint: joinTypeNameSegments(...projectedDescriptor.toolPath, "call"),
    },
  );
  const outputTypePreview = projectedDescriptor.resultShapeId
    ? input.typeProjector.renderSelfContainedShape(projectedDescriptor.resultShapeId, {
        aliasHint: joinTypeNameSegments(...projectedDescriptor.toolPath, "result"),
      })
    : undefined;

  return {
    path: path as CatalogToolDescriptor["path"],
    sourceKey: input.source.id,
    description: input.capability.surface.summary ?? input.capability.surface.description,
    interaction,
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    inputTypePreview,
    ...(outputTypePreview !== undefined ? { outputTypePreview } : {}),
    providerKind: input.executable.protocol,
    providerData: {
      capabilityId: input.capability.id,
      executableId: input.executable.id,
      protocol: input.executable.protocol,
    },
  };
};

const loadedCatalogToolFromCapability = (input: {
  catalogEntry: LoadedSourceCatalog;
  capability: Capability;
  includeSchemas: boolean;
}): LoadedSourceCatalogTool => {
  const executable = chooseExecutable(input.catalogEntry.projected.catalog, input.capability);
  const projectedDescriptor = input.catalogEntry.projected.toolDescriptors[input.capability.id];
  const descriptor = codemodeDescriptorFromCapability({
    source: input.catalogEntry.source,
    projected: input.catalogEntry.projected,
    capability: input.capability,
    executable,
    typeProjector: input.catalogEntry.typeProjector,
    includeSchemas: input.includeSchemas,
  });
  const path = descriptorPath(descriptor);
  const searchDoc = input.catalogEntry.projected.searchDocs[input.capability.id];
  const searchNamespace = catalogNamespaceFromPath(path);
  const searchText = [
    path,
    searchNamespace,
    input.catalogEntry.source.name,
    input.capability.surface.title,
    input.capability.surface.summary,
    input.capability.surface.description,
    ...(searchDoc?.tags ?? []),
    ...(searchDoc?.protocolHints ?? []),
    ...(searchDoc?.authHints ?? []),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();

  return {
    path,
    searchNamespace,
    searchText,
    source: input.catalogEntry.source,
    sourceRecord: input.catalogEntry.sourceRecord,
    revision: input.catalogEntry.revision,
    capabilityId: input.capability.id,
    executableId: executable.id,
    capability: input.capability,
    executable,
    projectedDescriptor,
    descriptor,
    projectedCatalog: input.catalogEntry.projected.catalog,
    typeProjector: input.catalogEntry.typeProjector,
  } satisfies LoadedSourceCatalogTool;
};

const sourceRecordFromCatalogArtifact = (input: {
  source: Source;
  artifact: {
    catalogId: StoredSourceRecord["catalogId"];
    revision: StoredSourceCatalogRevisionRecord;
  };
}): StoredSourceRecord => ({
  id: input.source.id,
  workspaceId: input.source.workspaceId,
  catalogId: input.artifact.catalogId,
  catalogRevisionId: input.artifact.revision.id,
  name: input.source.name,
  kind: input.source.kind,
  endpoint: input.source.endpoint,
  status: input.source.status,
  enabled: input.source.enabled,
  namespace: input.source.namespace,
  importAuthPolicy: input.source.importAuthPolicy,
  bindingConfigJson: JSON.stringify(input.source.binding),
  sourceHash: input.source.sourceHash,
  lastError: input.source.lastError,
  createdAt: input.source.createdAt,
  updatedAt: input.source.updatedAt,
});

type RuntimeSourceCatalogStoreShape = {
  loadWorkspaceSourceCatalogs: (input: {
    workspaceId: WorkspaceId;
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<readonly LoadedSourceCatalog[], Error, never>;
  loadSourceWithCatalog: (input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<LoadedSourceCatalog, Error | LocalSourceArtifactMissingError, never>;
  loadWorkspaceSourceCatalogToolIndex: (input: {
    workspaceId: WorkspaceId;
    actorAccountId?: AccountId | null;
    includeSchemas: boolean;
  }) => Effect.Effect<readonly LoadedSourceCatalogToolIndexEntry[], Error, never>;
  loadWorkspaceSourceCatalogToolByPath: (input: {
    workspaceId: WorkspaceId;
    path: string;
    actorAccountId?: AccountId | null;
    includeSchemas: boolean;
  }) => Effect.Effect<LoadedSourceCatalogToolIndexEntry | null, Error, never>;
};

export type RuntimeSourceCatalogStore = RuntimeSourceCatalogStoreShape;

export class RuntimeSourceCatalogStoreService extends Context.Tag(
  "#runtime/RuntimeSourceCatalogStoreService",
)<RuntimeSourceCatalogStoreService, RuntimeSourceCatalogStoreShape>() {}

type RuntimeSourceCatalogStoreDeps = {
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  sourceStore: RuntimeSourceStore;
  sourceArtifactStore: SourceArtifactStoreShape;
};

type SourceCatalogRuntimeServices =
  | RuntimeLocalWorkspaceService
  | RuntimeSourceStoreService
  | SourceArtifactStore;

const ensureRuntimeCatalogWorkspace = (
  deps: RuntimeSourceCatalogStoreDeps,
  workspaceId: WorkspaceId,
) => {
  if (deps.runtimeLocalWorkspace.installation.workspaceId !== workspaceId) {
    return Effect.fail(
      new Error(
        `Runtime local workspace mismatch: expected ${workspaceId}, got ${deps.runtimeLocalWorkspace.installation.workspaceId}`,
      ),
    );
  }

  return Effect.succeed(deps.runtimeLocalWorkspace.context);
};

const buildSnapshotFromArtifact = (input: {
  source: Source;
  artifact: LocalSourceArtifact;
}): CatalogSnapshotV1 => {
  return decodeCatalogSnapshotV1(input.artifact.snapshot);
};

const loadWorkspaceSourceCatalogsWithDeps = (deps: RuntimeSourceCatalogStoreDeps, input: {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
}): Effect.Effect<readonly LoadedSourceCatalog[], Error, never> =>
  Effect.gen(function* () {
    const workspaceContext = yield* ensureRuntimeCatalogWorkspace(
      deps,
      input.workspaceId,
    );
    const sources = yield* deps.sourceStore.loadSourcesInWorkspace(
      input.workspaceId,
      {
        actorAccountId: input.actorAccountId,
      },
    );

    const localCatalogs = yield* Effect.forEach(sources, (source) =>
      Effect.gen(function* () {
        const artifact = yield* deps.sourceArtifactStore.read({
          context: workspaceContext,
          sourceId: source.id,
        });
        if (artifact === null) {
          return null;
        }

        const snapshot = buildSnapshotFromArtifact({
          source,
          artifact,
        });
        const projected = projectCatalogForAgentSdk({
          catalog: snapshot.catalog,
        });
        const typeProjector = projectorForProjectedCatalog(projected);

        return {
          source,
          sourceRecord: sourceRecordFromCatalogArtifact({
            source,
            artifact,
          }),
          revision: artifact.revision,
          snapshot,
          catalog: snapshot.catalog,
          projected,
          typeProjector,
          importMetadata: snapshot.import,
        } satisfies LoadedSourceCatalog;
      }),
    );

    return localCatalogs.filter((catalogEntry): catalogEntry is LoadedSourceCatalog => catalogEntry !== null);
  });

const loadSourceWithCatalogWithDeps = (deps: RuntimeSourceCatalogStoreDeps, input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  actorAccountId?: AccountId | null;
}): Effect.Effect<LoadedSourceCatalog, Error | LocalSourceArtifactMissingError, never> =>
  Effect.gen(function* () {
    const workspaceContext = yield* ensureRuntimeCatalogWorkspace(
      deps,
      input.workspaceId,
    );
    const source = yield* deps.sourceStore.loadSourceById({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      actorAccountId: input.actorAccountId,
    });
    const artifact = yield* deps.sourceArtifactStore.read({
      context: workspaceContext,
      sourceId: source.id,
    });
    if (artifact === null) {
      return yield* Effect.fail(
        new LocalSourceArtifactMissingError({
          message: `Catalog artifact missing for source ${input.sourceId}`,
          sourceId: input.sourceId,
        }),
      );
    }

    const snapshot = buildSnapshotFromArtifact({
      source,
      artifact,
    });
    const projected = projectCatalogForAgentSdk({
      catalog: snapshot.catalog,
    });
    const typeProjector = projectorForProjectedCatalog(projected);

    return {
      source,
      sourceRecord: sourceRecordFromCatalogArtifact({
        source,
        artifact,
      }),
      revision: artifact.revision,
      snapshot,
      catalog: snapshot.catalog,
      projected,
      typeProjector,
      importMetadata: snapshot.import,
    } satisfies LoadedSourceCatalog;
  });

export const loadWorkspaceSourceCatalogs = (input: {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
}): Effect.Effect<readonly LoadedSourceCatalog[], Error, SourceCatalogRuntimeServices> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const sourceStore = yield* RuntimeSourceStoreService;
    const sourceArtifactStore = yield* SourceArtifactStore;

    return yield* loadWorkspaceSourceCatalogsWithDeps(
      {
        runtimeLocalWorkspace,
        sourceStore,
        sourceArtifactStore,
      },
      input,
    );
  });

export const loadSourceWithCatalog = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  actorAccountId?: AccountId | null;
}): Effect.Effect<
  LoadedSourceCatalog,
  Error | LocalSourceArtifactMissingError,
  SourceCatalogRuntimeServices
> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const sourceStore = yield* RuntimeSourceStoreService;
    const sourceArtifactStore = yield* SourceArtifactStore;

    return yield* loadSourceWithCatalogWithDeps(
      {
        runtimeLocalWorkspace,
        sourceStore,
        sourceArtifactStore,
      },
      input,
    );
  });

export const expandCatalogTools = (input: {
  catalogs: readonly LoadedSourceCatalog[];
  includeSchemas: boolean;
}): Effect.Effect<readonly LoadedSourceCatalogTool[], Error, never> =>
  Effect.succeed(
    input.catalogs.flatMap((catalogEntry) =>
      Object.values(catalogEntry.catalog.capabilities).map((capability) =>
        loadedCatalogToolFromCapability({
          catalogEntry,
          capability,
          includeSchemas: input.includeSchemas,
        })),
    ),
  );

export const expandCatalogToolByPath = (input: {
  catalogs: readonly LoadedSourceCatalog[];
  path: string;
  includeSchemas: boolean;
}): Effect.Effect<LoadedSourceCatalogTool | null, Error, never> =>
  Effect.succeed(
    input.catalogs
      .flatMap((catalogEntry) =>
        Object.values(catalogEntry.catalog.capabilities).flatMap((capability) => {
          return projectedToolPath(catalogEntry.projected, capability) === input.path
            ? [
                loadedCatalogToolFromCapability({
                  catalogEntry,
                  capability,
                  includeSchemas: input.includeSchemas,
                }),
              ]
            : [];
        }))
      .at(0) ?? null,
  );

export const loadWorkspaceSourceCatalogToolIndex = (input: {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  includeSchemas: boolean;
}): Effect.Effect<
  readonly LoadedSourceCatalogToolIndexEntry[],
  Error,
  SourceCatalogRuntimeServices
> =>
  Effect.gen(function* () {
    const catalogs = yield* loadWorkspaceSourceCatalogs({
      workspaceId: input.workspaceId,
      actorAccountId: input.actorAccountId,
    });
    const tools = yield* expandCatalogTools({
      catalogs,
      includeSchemas: input.includeSchemas,
    });
    return tools.map((tool) => ({
      path: tool.path,
      searchNamespace: tool.searchNamespace,
      searchText: tool.searchText,
      source: tool.source,
      sourceRecord: tool.sourceRecord,
      capabilityId: tool.capabilityId,
      executableId: tool.executableId,
      capability: tool.capability,
      executable: tool.executable,
      descriptor: tool.descriptor,
      projectedCatalog: tool.projectedCatalog,
    }));
  });

export const loadWorkspaceSourceCatalogToolByPath = (input: {
  workspaceId: WorkspaceId;
  path: string;
  actorAccountId?: AccountId | null;
  includeSchemas: boolean;
}): Effect.Effect<
  LoadedSourceCatalogToolIndexEntry | null,
  Error,
  SourceCatalogRuntimeServices
> =>
  Effect.gen(function* () {
    const catalogs = yield* loadWorkspaceSourceCatalogs({
      workspaceId: input.workspaceId,
      actorAccountId: input.actorAccountId,
    });
    const tool = yield* expandCatalogToolByPath({
      catalogs,
      path: input.path,
      includeSchemas: input.includeSchemas,
    });
    return tool
      ? {
          path: tool.path,
          searchNamespace: tool.searchNamespace,
          searchText: tool.searchText,
          source: tool.source,
          sourceRecord: tool.sourceRecord,
          capabilityId: tool.capabilityId,
          executableId: tool.executableId,
          capability: tool.capability,
          executable: tool.executable,
          descriptor: tool.descriptor,
          projectedCatalog: tool.projectedCatalog,
        }
      : null;
  });

export const RuntimeSourceCatalogStoreLive = Layer.effect(
  RuntimeSourceCatalogStoreService,
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const sourceStore = yield* RuntimeSourceStoreService;
    const sourceArtifactStore = yield* SourceArtifactStore;

    const deps: RuntimeSourceCatalogStoreDeps = {
      runtimeLocalWorkspace,
      sourceStore,
      sourceArtifactStore,
    };

    return RuntimeSourceCatalogStoreService.of({
      loadWorkspaceSourceCatalogs: (input) =>
        loadWorkspaceSourceCatalogsWithDeps(deps, input),
      loadSourceWithCatalog: (input) =>
        loadSourceWithCatalogWithDeps(deps, input),
      loadWorkspaceSourceCatalogToolIndex: (input) =>
        loadWorkspaceSourceCatalogToolIndex(input).pipe(
          Effect.provideService(RuntimeLocalWorkspaceService, runtimeLocalWorkspace),
          Effect.provideService(RuntimeSourceStoreService, sourceStore),
          Effect.provideService(SourceArtifactStore, sourceArtifactStore),
        ),
      loadWorkspaceSourceCatalogToolByPath: (input) =>
        loadWorkspaceSourceCatalogToolByPath(input).pipe(
          Effect.provideService(RuntimeLocalWorkspaceService, runtimeLocalWorkspace),
          Effect.provideService(RuntimeSourceStoreService, sourceStore),
          Effect.provideService(SourceArtifactStore, sourceArtifactStore),
        ),
    });
  }),
);

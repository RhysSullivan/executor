import { typeSignatureFromSchemaJson } from "@executor-v3/codemode-core";
import {
  buildOpenApiToolPresentation,
  compileOpenApiToolDefinitions,
  extractOpenApiManifest,
  openApiOutputTypeSignatureFromSchemaJson,
  type OpenApiToolDefinition,
  type OpenApiToolManifest,
} from "@executor-v3/codemode-openapi";
import type {
  Source,
  SourceId,
  SourceInspection,
  SourceInspectionDiscoverPayload,
  SourceInspectionDiscoverResult,
  SourceInspectionDiscoverResultItem,
  SourceInspectionToolDetail,
  SourceInspectionToolSummary,
  StoredSourceRecord,
  WorkspaceId,
} from "#schema";
import {
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
} from "#api";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { operationErrors } from "./operation-errors";
import { formatJsonIfNeeded, formatWithPrettier } from "./prettier-format";
import {
  buildGraphqlToolPresentation,
  compileGraphqlToolDefinitions,
  extractGraphqlManifest,
  type GraphqlToolDefinition,
  type GraphqlToolManifest,
} from "./graphql-tools";
import { loadSourceById as loadStoredSourceById } from "./source-store";
import { ControlPlaneStore, type ControlPlaneStoreShape } from "./store";
import { namespaceFromSourceName } from "./tool-artifacts";

const sourceInspectOps = {
  bundle: operationErrors("sources.inspect.bundle"),
  tool: operationErrors("sources.inspect.tool"),
  discover: operationErrors("sources.inspect.discover"),
} as const;

const asPrettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

const tokenize = (value: string): Array<string> =>
  value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const searchTextFromSummary = (summary: SourceInspectionToolSummary): string =>
  [
    summary.path,
    summary.toolId,
    summary.rawToolId ?? "",
    summary.operationId ?? "",
    summary.title ?? "",
    summary.description ?? "",
    summary.method ?? "",
    summary.pathTemplate ?? "",
    summary.tags.join(" "),
    summary.inputType ?? "",
    summary.outputType ?? "",
  ]
    .join(" ")
    .toLowerCase();

type InspectionToolRecord = {
  summary: SourceInspectionToolSummary;
  detail: SourceInspectionToolDetail;
  searchText: string;
};

type ResolvedSourceInspection = {
  source: Source;
  namespace: string;
  pipelineKind: SourceInspection["pipelineKind"];
  rawDocumentText: string | null;
  manifestJson: string | null;
  definitionsJson: string | null;
  tools: ReadonlyArray<InspectionToolRecord>;
};

const formatOptionalJson = (value: string | null) =>
  value === null
    ? Effect.succeed<string | null>(null)
    : Effect.promise(() => formatWithPrettier(value, "json"));

const formatOptionalTypeScript = (value: string | undefined) =>
  value === undefined
    ? Effect.succeed<string | undefined>(undefined)
    : Effect.promise(() => formatWithPrettier(value, "typescript"));

const formatToolSummary = (summary: SourceInspectionToolSummary) =>
  Effect.all({
    inputType: formatOptionalTypeScript(summary.inputType),
    outputType: formatOptionalTypeScript(summary.outputType),
  }).pipe(
    Effect.map(({ inputType, outputType }) => ({
      ...summary,
      ...(inputType ? { inputType } : {}),
      ...(outputType ? { outputType } : {}),
    } satisfies SourceInspectionToolSummary)),
  );

const formatInspectionToolRecord = (record: InspectionToolRecord) =>
  Effect.gen(function* () {
    const summary = yield* formatToolSummary(record.summary);
    const detailFields = yield* Effect.all({
      definitionJson: formatOptionalJson(record.detail.definitionJson),
      documentationJson: formatOptionalJson(record.detail.documentationJson),
      providerDataJson: formatOptionalJson(record.detail.providerDataJson),
      inputSchemaJson: formatOptionalJson(record.detail.inputSchemaJson),
      outputSchemaJson: formatOptionalJson(record.detail.outputSchemaJson),
      exampleInputJson: formatOptionalJson(record.detail.exampleInputJson),
      exampleOutputJson: formatOptionalJson(record.detail.exampleOutputJson),
    });

    return {
      summary,
      detail: {
        ...record.detail,
        ...detailFields,
        summary,
      },
      searchText: record.searchText,
    } satisfies InspectionToolRecord;
  });

const loadSourceRecord = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
}) =>
  Effect.flatMap(ControlPlaneStore, (store) =>
    Effect.gen(function* () {
      const sourceRecord = yield* sourceInspectOps.bundle.child("record").mapStorage(
        store.sources.getByWorkspaceAndId(input.workspaceId, input.sourceId),
      );
      if (Option.isNone(sourceRecord)) {
        return yield* Effect.fail(
          sourceInspectOps.bundle.notFound(
            "Source not found",
            `workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
          ),
        );
      }

      const source = yield* loadStoredSourceById(store, {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
      }).pipe(
        Effect.mapError((cause) =>
          sourceInspectOps.bundle.unknownStorage(
            cause,
            "Failed projecting stored source",
          ),
        ),
      );

      return {
        store,
        source,
        sourceRecord: sourceRecord.value,
      };
    }),
  );

const persistedToolSummaryFromArtifact = (input: {
  source: Source;
  artifact: {
    path: string;
    toolId: string;
    title: string | null;
    description: string | null;
    providerKind: string;
    openApiRawToolId: string | null;
    openApiOperationId: string | null;
    openApiTagsJson: string | null;
    openApiMethod: SourceInspectionToolSummary["method"];
    openApiPathTemplate: string | null;
    inputSchemaJson: string | null;
    outputSchemaJson: string | null;
  };
}): SourceInspectionToolSummary => ({
  path: input.artifact.path,
  sourceKey: input.source.id,
  ...(input.artifact.title ? { title: input.artifact.title } : {}),
  ...(input.artifact.description ? { description: input.artifact.description } : {}),
  providerKind: input.artifact.providerKind,
  toolId: input.artifact.toolId,
  rawToolId: input.artifact.openApiRawToolId,
  operationId: input.artifact.openApiOperationId,
  group: null,
  leaf: null,
  tags: input.artifact.openApiTagsJson
    ? ((JSON.parse(input.artifact.openApiTagsJson) as Array<string>) ?? [])
    : [],
  method: input.artifact.openApiMethod,
  pathTemplate: input.artifact.openApiPathTemplate,
  ...(input.artifact.inputSchemaJson
    ? {
        inputType: typeSignatureFromSchemaJson(
          input.artifact.inputSchemaJson,
          "unknown",
          Infinity,
        ),
      }
    : {}),
  ...(input.artifact.providerKind === "openapi"
    ? {
        outputType: openApiOutputTypeSignatureFromSchemaJson(
          input.artifact.outputSchemaJson ?? undefined,
          Infinity,
        ),
      }
    : input.artifact.outputSchemaJson
      ? {
          outputType: typeSignatureFromSchemaJson(
            input.artifact.outputSchemaJson,
            "unknown",
            Infinity,
          ),
        }
      : {}),
});

const openApiToolRecord = (input: {
  source: Source;
  namespace: string;
  manifest: OpenApiToolManifest;
  definition: OpenApiToolDefinition;
}): InspectionToolRecord => {
  const presentation = buildOpenApiToolPresentation({
    manifest: input.manifest,
    definition: input.definition,
  });
  const path = `${input.namespace}.${input.definition.toolId}`;
  const summary: SourceInspectionToolSummary = {
    path,
    sourceKey: input.source.id,
    title: input.definition.name,
    description: input.definition.description,
    providerKind: "openapi",
    toolId: input.definition.toolId,
    rawToolId: input.definition.rawToolId,
    operationId: input.definition.operationId ?? null,
    group: input.definition.group,
    leaf: input.definition.leaf,
    tags: [...input.definition.tags],
    method: input.definition.method,
    pathTemplate: input.definition.path,
    inputType: presentation.inputType,
    outputType: presentation.outputType,
  };

  return {
    summary,
    detail: {
      summary,
      definitionJson: asPrettyJson(input.definition),
      documentationJson: input.definition.documentation
        ? asPrettyJson(input.definition.documentation)
        : null,
      providerDataJson: presentation.providerDataJson,
      inputSchemaJson: presentation.inputSchemaJson ?? null,
      outputSchemaJson: presentation.outputSchemaJson ?? null,
      exampleInputJson: presentation.exampleInputJson ?? null,
      exampleOutputJson: presentation.exampleOutputJson ?? null,
    },
    searchText: searchTextFromSummary(summary),
  };
};

const graphqlToolRecord = (input: {
  source: Source;
  namespace: string;
  manifest: GraphqlToolManifest;
  definition: GraphqlToolDefinition;
}): InspectionToolRecord => {
  const presentation = buildGraphqlToolPresentation({
    manifest: input.manifest,
    definition: input.definition,
  });
  const path = `${input.namespace}.${input.definition.toolId}`;
  const summary: SourceInspectionToolSummary = {
    path,
    sourceKey: input.source.id,
    title: input.definition.name,
    description: input.definition.description,
    providerKind: "graphql",
    toolId: input.definition.toolId,
    rawToolId: input.definition.rawToolId,
    operationId: input.definition.operationName,
    group: input.definition.group,
    leaf: input.definition.leaf,
    tags: [],
    method: null,
    pathTemplate: null,
    inputType: presentation.inputType,
    outputType: presentation.outputType,
  };

  return {
    summary,
    detail: {
      summary,
      definitionJson: asPrettyJson(input.definition),
      documentationJson: null,
      providerDataJson: presentation.providerDataJson,
      inputSchemaJson: presentation.inputSchemaJson ?? null,
      outputSchemaJson: presentation.outputSchemaJson ?? null,
      exampleInputJson: presentation.exampleInputJson ?? null,
      exampleOutputJson: null,
    },
    searchText: searchTextFromSummary(summary),
  };
};

const loadPersistedInspection = (input: {
  store: ControlPlaneStoreShape;
  source: Source;
}): Effect.Effect<ResolvedSourceInspection, Error, never> =>
  Effect.gen(function* () {
    const artifacts = yield* sourceInspectOps.bundle.child("artifacts").mapStorage(
      input.store.toolArtifacts.listByWorkspaceId(input.source.workspaceId, {
        sourceId: input.source.id,
        limit: 1000,
      }),
    );
    const namespace = input.source.namespace ?? namespaceFromSourceName(input.source.name);
    const tools = yield* Effect.forEach(artifacts, (artifact) => {
      const summary = persistedToolSummaryFromArtifact({
        source: input.source,
        artifact,
      });
      return formatInspectionToolRecord({
        summary,
        detail: {
          summary,
          definitionJson: null,
          documentationJson: null,
          providerDataJson: null,
          inputSchemaJson: artifact.inputSchemaJson,
          outputSchemaJson: artifact.outputSchemaJson,
          exampleInputJson: null,
          exampleOutputJson: null,
        },
        searchText: searchTextFromSummary(summary),
      } satisfies InspectionToolRecord);
    });

    return {
      source: input.source,
      namespace,
      pipelineKind: "persisted",
      rawDocumentText: null,
      manifestJson: null,
      definitionsJson: null,
      tools,
    } satisfies ResolvedSourceInspection;
  });

const loadOpenApiInspection = (input: {
  source: Source;
  sourceRecord: StoredSourceRecord;
}): Effect.Effect<ResolvedSourceInspection, Error, never> =>
  Effect.gen(function* () {
    const rawDocumentText = input.sourceRecord.sourceDocumentText;
    if (!rawDocumentText) {
      return yield* Effect.fail(new Error("Missing stored OpenAPI document"));
    }

    const manifest = yield* extractOpenApiManifest(
      input.source.name,
      rawDocumentText,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
    const definitions = compileOpenApiToolDefinitions(manifest);
    const namespace = input.source.namespace ?? namespaceFromSourceName(input.source.name);
    const tools = yield* Effect.forEach(definitions, (definition) =>
      formatInspectionToolRecord(openApiToolRecord({
        source: input.source,
        namespace,
        manifest,
        definition,
      })),
    );
    const manifestJson = yield* Effect.promise(() =>
      formatWithPrettier(asPrettyJson(manifest), "json"),
    );
    const definitionsJson = yield* Effect.promise(() =>
      formatWithPrettier(asPrettyJson(definitions), "json"),
    );
    const formattedRawDocumentText = yield* Effect.promise(() =>
      formatJsonIfNeeded(rawDocumentText),
    );

    return {
      source: input.source,
      namespace,
      pipelineKind: "openapi",
      rawDocumentText: formattedRawDocumentText,
      manifestJson,
      definitionsJson,
      tools,
    } satisfies ResolvedSourceInspection;
  });

const loadGraphqlInspection = (input: {
  source: Source;
  sourceRecord: StoredSourceRecord;
}): Effect.Effect<ResolvedSourceInspection, Error, never> =>
  Effect.gen(function* () {
    const rawDocumentText = input.sourceRecord.sourceDocumentText;
    if (!rawDocumentText) {
      return yield* Effect.fail(new Error("Missing stored GraphQL document"));
    }

    const manifest = yield* extractGraphqlManifest(
      input.source.name,
      rawDocumentText,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
    const definitions = compileGraphqlToolDefinitions(manifest);
    const namespace = input.source.namespace ?? namespaceFromSourceName(input.source.name);
    const tools = yield* Effect.forEach(definitions, (definition) =>
      formatInspectionToolRecord(graphqlToolRecord({
        source: input.source,
        namespace,
        manifest,
        definition,
      })),
    );
    const manifestJson = yield* Effect.promise(() =>
      formatWithPrettier(asPrettyJson(manifest), "json"),
    );
    const definitionsJson = yield* Effect.promise(() =>
      formatWithPrettier(asPrettyJson(definitions), "json"),
    );
    const formattedRawDocumentText = yield* Effect.promise(() =>
      formatJsonIfNeeded(rawDocumentText),
    );

    return {
      source: input.source,
      namespace,
      pipelineKind: "graphql",
      rawDocumentText: formattedRawDocumentText,
      manifestJson,
      definitionsJson,
      tools,
    } satisfies ResolvedSourceInspection;
  });

const resolveSourceInspection = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
}) =>
  Effect.gen(function* () {
    const { store, source, sourceRecord } = yield* loadSourceRecord(input);

    if (source.kind === "openapi" && sourceRecord.sourceDocumentText) {
      return yield* loadOpenApiInspection({
        source,
        sourceRecord,
      }).pipe(
        Effect.catchAll(() =>
          loadPersistedInspection({
            store,
            source,
          }),
        ),
      );
    }

    if (source.kind === "graphql" && sourceRecord.sourceDocumentText) {
      return yield* loadGraphqlInspection({
        source,
        sourceRecord,
      }).pipe(
        Effect.catchAll(() =>
          loadPersistedInspection({
            store,
            source,
          }),
        ),
      );
    }

    return yield* loadPersistedInspection({
      store,
      source,
    });
  });

const scoreTool = (input: {
  queryTokens: ReadonlyArray<string>;
  tool: InspectionToolRecord;
}): SourceInspectionDiscoverResultItem | null => {
  let score = 0;
  const reasons: Array<string> = [];
  const pathTokens = tokenize(input.tool.summary.path);
  const titleTokens = tokenize(input.tool.summary.title ?? "");
  const descriptionTokens = tokenize(input.tool.summary.description ?? "");
  const tagTokens = input.tool.summary.tags.flatMap(tokenize);
  const typeTokens = tokenize(
    `${input.tool.summary.inputType ?? ""} ${input.tool.summary.outputType ?? ""}`,
  );
  const methodPathTokens = tokenize(
    `${input.tool.summary.method ?? ""} ${input.tool.summary.pathTemplate ?? ""}`,
  );

  for (const token of input.queryTokens) {
    if (pathTokens.includes(token)) {
      score += 12;
      reasons.push(`path matches ${token} (+12)`);
      continue;
    }
    if (tagTokens.includes(token)) {
      score += 10;
      reasons.push(`tag matches ${token} (+10)`);
      continue;
    }
    if (titleTokens.includes(token)) {
      score += 8;
      reasons.push(`title matches ${token} (+8)`);
      continue;
    }
    if (methodPathTokens.includes(token)) {
      score += 6;
      reasons.push(`method/path matches ${token} (+6)`);
      continue;
    }
    if (typeTokens.includes(token)) {
      score += 4;
      reasons.push(`type signature matches ${token} (+4)`);
      continue;
    }
    if (descriptionTokens.includes(token) || input.tool.searchText.includes(token)) {
      score += 2;
      reasons.push(`description/text matches ${token} (+2)`);
    }
  }

  if (score <= 0) {
    return null;
  }

  return {
    path: input.tool.summary.path,
    score,
    ...(input.tool.summary.description
      ? { description: input.tool.summary.description }
      : {}),
    ...(input.tool.summary.inputType
      ? { inputType: input.tool.summary.inputType }
      : {}),
    ...(input.tool.summary.outputType
      ? { outputType: input.tool.summary.outputType }
      : {}),
    reasons,
  } satisfies SourceInspectionDiscoverResultItem;
};

const mapInspectionError = (
  operation:
    | typeof sourceInspectOps.bundle
    | typeof sourceInspectOps.tool
    | typeof sourceInspectOps.discover,
  cause: unknown,
  details: string,
): ControlPlaneNotFoundError | ControlPlaneStorageError => {
  if (cause instanceof ControlPlaneNotFoundError) {
    return cause;
  }
  if (cause instanceof ControlPlaneStorageError) {
    return cause;
  }

  return operation.unknownStorage(cause, details);
};

export const getSourceInspection = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
}) =>
  Effect.gen(function* () {
    const inspection = yield* resolveSourceInspection(input);

    return {
      source: inspection.source,
      namespace: inspection.namespace,
      pipelineKind: inspection.pipelineKind,
      toolCount: inspection.tools.length,
      rawDocumentText: inspection.rawDocumentText,
      manifestJson: inspection.manifestJson,
      definitionsJson: inspection.definitionsJson,
      tools: inspection.tools.map((tool) => tool.summary),
    } satisfies SourceInspection;
  }).pipe(
    Effect.mapError((cause) =>
      mapInspectionError(
        sourceInspectOps.bundle,
        cause,
        "Failed building source inspection bundle",
      )),
  );

export const getSourceInspectionToolDetail = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  toolPath: string;
}) =>
  Effect.gen(function* () {
    const inspection = yield* resolveSourceInspection({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });
    const tool = inspection.tools.find((candidate) => candidate.summary.path === input.toolPath);

    if (!tool) {
      return yield* Effect.fail(
        sourceInspectOps.tool.notFound(
          "Tool not found",
          `workspaceId=${input.workspaceId} sourceId=${input.sourceId} path=${input.toolPath}`,
        ),
      );
    }

    return tool.detail;
  }).pipe(
    Effect.mapError((cause) =>
      mapInspectionError(
        sourceInspectOps.tool,
        cause,
        "Failed building source inspection tool detail",
      )),
  );

export const discoverSourceInspectionTools = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  payload: SourceInspectionDiscoverPayload;
}) =>
  Effect.gen(function* () {
    const inspection = yield* resolveSourceInspection({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });
    const queryTokens = tokenize(input.payload.query);
    const results = inspection.tools
      .map((tool) =>
        scoreTool({
          queryTokens,
          tool,
        }),
      )
      .filter((value): value is SourceInspectionDiscoverResultItem => value !== null)
      .sort((left, right) =>
        right.score - left.score || left.path.localeCompare(right.path),
      )
      .slice(0, input.payload.limit ?? 12);

    return {
      query: input.payload.query,
      queryTokens,
      bestPath: results[0]?.path ?? null,
      total: results.length,
      results,
    } satisfies SourceInspectionDiscoverResult;
  }).pipe(
    Effect.mapError((cause) =>
      mapInspectionError(
        sourceInspectOps.discover,
        cause,
        "Failed building source inspection discovery",
      )),
  );

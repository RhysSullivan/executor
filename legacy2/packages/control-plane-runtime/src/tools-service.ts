import {
  type SourceStoreError,
  type ToolArtifactStoreError,
  type SourceStore,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import {
  makeControlPlaneToolsService,
  type ControlPlaneToolsServiceShape,
  type SourceToolDetail,
  type SourceToolSummary,
} from "@executor-v2/management-api";
import {
  OpenApiToolManifestSchema,
  type Source,
  type SourceId,
  type ToolArtifact,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import { createSqlSourceStoreErrorMapper } from "./control-plane-row-helpers";

const decodeOpenApiToolManifest = Schema.decodeUnknown(OpenApiToolManifestSchema);
const sourceStoreError = createSqlSourceStoreErrorMapper("tool_artifacts");

const toSourceStoreErrorFromSourceStore = (
  operation: string,
  error: SourceStoreError,
): SourceStoreError =>
  sourceStoreError.fromMessage(
    operation,
    error.message,
    error.details ?? error.reason ?? null,
  );

const toSourceStoreErrorFromToolArtifactStore = (
  operation: string,
  error: ToolArtifactStoreError,
): SourceStoreError =>
  sourceStoreError.fromMessage(
    operation,
    error.message,
    error.details ?? error.reason ?? null,
  );

const parseArtifactManifest = (
  source: Source,
  artifact: ToolArtifact,
): Effect.Effect<ReadonlyArray<SourceToolSummary>, SourceStoreError> =>
  Effect.try({
    try: () => JSON.parse(artifact.manifestJson) as unknown,
    catch: (cause) =>
      sourceStoreError.fromMessage(
        "tools.decode_manifest_json",
        cause instanceof Error ? cause.message : String(cause),
        `sourceId=${source.id}`,
      ),
  }).pipe(
    Effect.flatMap((manifestJson) =>
      decodeOpenApiToolManifest(manifestJson).pipe(
        Effect.mapError((cause) =>
          sourceStoreError.fromMessage(
            "tools.decode_manifest",
            "Unable to decode OpenAPI manifest",
            ParseResult.TreeFormatter.formatErrorSync(cause),
          ),
        ),
      )
    ),
    Effect.map((manifest) =>
      manifest.tools.map((tool) => ({
        sourceId: source.id,
        sourceName: source.name,
        sourceKind: source.kind,
        toolId: tool.toolId,
        name: tool.name,
        description: tool.description,
        method: tool.method,
        path: tool.path,
        operationHash: tool.operationHash,
      })),
    ),
  );

const sortTools = (tools: ReadonlyArray<SourceToolSummary>): Array<SourceToolSummary> =>
  [...tools].sort((left, right) => {
    const leftSource = left.sourceName.toLowerCase();
    const rightSource = right.sourceName.toLowerCase();

    if (leftSource !== rightSource) {
      return leftSource.localeCompare(rightSource);
    }

    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName !== rightName) {
      return leftName.localeCompare(rightName);
    }

    return left.toolId.localeCompare(right.toolId);
  });

const listSourceTools = (
  sourceStore: SourceStore,
  toolArtifactStore: ToolArtifactStore,
  input: {
    workspaceId: WorkspaceId;
    sourceId: SourceId;
  },
): Effect.Effect<ReadonlyArray<SourceToolSummary>, SourceStoreError> =>
  Effect.gen(function* () {
    const sourceOption = yield* sourceStore.getById(input.workspaceId, input.sourceId).pipe(
      Effect.mapError((error) =>
        toSourceStoreErrorFromSourceStore("tools.get_source", error),
      ),
    );

    const source = Option.getOrNull(sourceOption);
    if (source === null) {
      return [];
    }

    const artifactOption = yield* toolArtifactStore
      .getBySource(input.workspaceId, input.sourceId)
      .pipe(
        Effect.mapError((error) =>
          toSourceStoreErrorFromToolArtifactStore("tools.get_artifact", error),
        ),
      );

    const artifact = Option.getOrNull(artifactOption);
    if (artifact === null) {
      return [];
    }

    return yield* parseArtifactManifest(source, artifact);
  });

export const createRuntimeHostToolsService = (
  sourceStore: SourceStore,
  toolArtifactStore: ToolArtifactStore,
): ControlPlaneToolsServiceShape =>
  makeControlPlaneToolsService({
    listWorkspaceTools: (workspaceId) =>
      Effect.gen(function* () {
        const sources = yield* sourceStore.listByWorkspace(workspaceId).pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromSourceStore("tools.list_sources", error),
          ),
        );

        const toolGroups = yield* Effect.forEach(
          sources,
          (source) =>
            listSourceTools(sourceStore, toolArtifactStore, {
              workspaceId,
              sourceId: source.id,
            }),
          {
            concurrency: "unbounded",
          },
        );

        return sortTools(toolGroups.flat());
      }),

    listSourceTools: (input) =>
      listSourceTools(sourceStore, toolArtifactStore, {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
      }),

    getToolDetail: (input) =>
      Effect.gen(function* () {
        const sourceOption = yield* sourceStore
          .getById(input.workspaceId, input.sourceId)
          .pipe(
            Effect.mapError((error) =>
              toSourceStoreErrorFromSourceStore("tools.get_detail_source", error),
            ),
          );

        const source = Option.getOrNull(sourceOption);
        if (source === null) {
          return null;
        }

        const artifactOption = yield* toolArtifactStore
          .getBySource(input.workspaceId, input.sourceId)
          .pipe(
            Effect.mapError((error) =>
              toSourceStoreErrorFromToolArtifactStore("tools.get_detail_artifact", error),
            ),
          );

        const artifact = Option.getOrNull(artifactOption);
        if (artifact === null) {
          return null;
        }

        const manifestResult = yield* Effect.try({
          try: () => JSON.parse(artifact.manifestJson) as unknown,
          catch: () => null as never,
        }).pipe(Effect.option);

        if (Option.isNone(manifestResult)) {
          return null;
        }

        const decoded = yield* decodeOpenApiToolManifest(manifestResult.value).pipe(
          Effect.option,
        );

        if (Option.isNone(decoded)) {
          return null;
        }

        const manifest = decoded.value;
        const tool = manifest.tools.find((t) => t.operationHash === input.operationHash);
        if (!tool) {
          return null;
        }



        const detail: SourceToolDetail = {
          sourceId: source.id,
          sourceName: source.name,
          sourceKind: source.kind,
          toolId: tool.toolId,
          name: tool.name,
          description: tool.description,
          method: tool.method,
          path: tool.path,
          operationHash: tool.operationHash,
          inputSchemaJson: tool.typing?.inputSchemaJson ?? null,
          outputSchemaJson: tool.typing?.outputSchemaJson ?? null,
          refHintTableJson: manifest.refHintTable
            ? JSON.stringify(manifest.refHintTable)
            : null,
        };

        return detail;
      }),
  });

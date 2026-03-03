import {
  ToolArtifactStoreError,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import {
  OpenApiToolManifestSchema,
  ToolArtifactIdSchema,
  type Source,
  type ToolArtifact,
  type OpenApiToolManifest,
} from "@executor-v2/schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import { extractOpenApiManifestJsonWithWasm } from "./openapi-extractor-wasm";

type OpenApiExtractionStage = "validate" | "extract" | "encode_manifest";

export class OpenApiExtractionError extends Data.TaggedError("OpenApiExtractionError")<{
  sourceName: string;
  stage: OpenApiExtractionStage;
  message: string;
  details: string | null;
}> {}

const manifestFromJsonSchema = Schema.parseJson(OpenApiToolManifestSchema);
const decodeManifestFromJson = Schema.decodeUnknown(manifestFromJsonSchema);
const encodeManifestToJson = Schema.encode(manifestFromJsonSchema);
const decodeToolArtifactId = Schema.decodeUnknownSync(ToolArtifactIdSchema);

export type ToolManifestDiff = {
  added: Array<string>;
  changed: Array<string>;
  removed: Array<string>;
  unchangedCount: number;
};

export type RefreshOpenApiArtifactResult = {
  artifact: ToolArtifact;
  manifest: OpenApiToolManifest;
  diff: ToolManifestDiff;
  reused: boolean;
};

type RefreshOpenApiArtifactInput = {
  source: Source;
  openApiSpec: unknown;
  artifactStore: ToolArtifactStore;
  now?: () => number;
};

const toExtractionError = (
  sourceName: string,
  stage: OpenApiExtractionStage,
  cause: unknown,
): OpenApiExtractionError =>
  cause instanceof OpenApiExtractionError
    ? cause
    : new OpenApiExtractionError({
        sourceName,
        stage,
        message: "OpenAPI extraction failed",
        details: ParseResult.isParseError(cause)
          ? ParseResult.TreeFormatter.formatErrorSync(cause)
          : String(cause),
      });

const normalizeOpenApiDocumentText = (
  sourceName: string,
  openApiSpec: unknown,
): Effect.Effect<string, OpenApiExtractionError> => {
  if (typeof openApiSpec === "string") {
    return Effect.succeed(openApiSpec);
  }

  return Effect.try({
    try: () => JSON.stringify(openApiSpec),
    catch: (cause) =>
      new OpenApiExtractionError({
        sourceName,
        stage: "validate",
        message: "Unable to serialize OpenAPI input",
        details: String(cause),
      }),
  });
};

export const extractOpenApiManifest = (
  sourceName: string,
  openApiSpec: unknown,
): Effect.Effect<OpenApiToolManifest, OpenApiExtractionError> =>
  Effect.gen(function* () {
    const openApiDocumentText = yield* normalizeOpenApiDocumentText(sourceName, openApiSpec);

    const manifestJson = yield* Effect.tryPromise({
      try: () => extractOpenApiManifestJsonWithWasm(sourceName, openApiDocumentText),
      catch: (cause) => toExtractionError(sourceName, "extract", cause),
    });

    return yield* decodeManifestFromJson(manifestJson).pipe(
      Effect.mapError((cause) => toExtractionError(sourceName, "extract", cause)),
    );
  });

const makeToolArtifactId = (source: Source): ToolArtifact["id"] =>
  decodeToolArtifactId(`tool_artifact_${source.id}`);

const diffForReusedManifest = (manifest: OpenApiToolManifest): ToolManifestDiff => ({
  added: [],
  changed: [],
  removed: [],
  unchangedCount: manifest.tools.length,
});

const diffForReplacedManifest = (manifest: OpenApiToolManifest): ToolManifestDiff => ({
  added: manifest.tools.map((tool) => tool.toolId),
  changed: [],
  removed: [],
  unchangedCount: 0,
});

export const refreshOpenApiArtifact = (
  input: RefreshOpenApiArtifactInput,
): Effect.Effect<RefreshOpenApiArtifactResult, ToolArtifactStoreError | OpenApiExtractionError> =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now;

    const manifest = yield* extractOpenApiManifest(input.source.name, input.openApiSpec);
    const existingArtifactOption = yield* input.artifactStore.getBySource(
      input.source.workspaceId,
      input.source.id,
    );

    const existingArtifact = Option.getOrUndefined(existingArtifactOption);

    if (existingArtifact && existingArtifact.sourceHash === manifest.sourceHash) {
      return {
        artifact: existingArtifact,
        manifest,
        diff: diffForReusedManifest(manifest),
        reused: true,
      };
    }

    const currentTime = now();
    const manifestJson = yield* pipe(
      encodeManifestToJson(manifest),
      Effect.mapError((cause) =>
        toExtractionError(input.source.name, "encode_manifest", cause),
      ),
    );

    const nextArtifact: ToolArtifact = {
      id: existingArtifact?.id ?? makeToolArtifactId(input.source),
      workspaceId: input.source.workspaceId,
      sourceId: input.source.id,
      sourceHash: manifest.sourceHash,
      toolCount: manifest.tools.length,
      manifestJson,
      createdAt: existingArtifact?.createdAt ?? currentTime,
      updatedAt: currentTime,
    };

    yield* input.artifactStore.upsert(nextArtifact);

    return {
      artifact: nextArtifact,
      manifest,
      diff: diffForReplacedManifest(manifest),
      reused: false,
    };
  });

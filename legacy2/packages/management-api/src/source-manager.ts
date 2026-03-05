import {
  ToolArtifactStoreError,
  ToolArtifactStoreService,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import type { Source } from "@executor-v2/schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OpenApiExtractionError,
  extractOpenApiManifest,
  refreshOpenApiArtifact,
  type RefreshOpenApiArtifactResult,
  type ToolManifestDiff,
} from "./openapi-extraction";

export type RefreshOpenApiArtifactRequest = {
  source: Source;
  openApiSpec: unknown;
  now?: () => number;
};

export type SourceManagerService = {
  refreshOpenApiArtifact: (
    input: RefreshOpenApiArtifactRequest,
  ) => Effect.Effect<
    RefreshOpenApiArtifactResult,
    OpenApiExtractionError | ToolArtifactStoreError
  >;
};

export class SourceManager extends Context.Tag("@executor-v2/management-api/SourceManager")<
  SourceManager,
  SourceManagerService
>() {}

export const makeSourceManagerService = (
  artifactStore: ToolArtifactStore,
): SourceManagerService => ({
  refreshOpenApiArtifact: (input) =>
    refreshOpenApiArtifact({
      ...input,
      artifactStore,
    }),
});

export const SourceManagerLive = Layer.effect(
  SourceManager,
  Effect.gen(function* () {
    const artifactStore = yield* ToolArtifactStoreService;

    return SourceManager.of(makeSourceManagerService(artifactStore));
  }),
);

export {
  OpenApiExtractionError,
  extractOpenApiManifest,
  refreshOpenApiArtifact,
  type RefreshOpenApiArtifactResult,
  type ToolManifestDiff,
};

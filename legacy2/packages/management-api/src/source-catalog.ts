import {
  SourceStoreError,
  SourceStoreService,
  type SourceStore,
} from "@executor-v2/persistence-ports";
import {
  SourceIdSchema,
  SourceSchema,
  type Source,
  type SourceId,
  type SourceKind,
  type SourceStatus,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

export class SourceCatalogValidationError extends Data.TaggedError(
  "SourceCatalogValidationError",
)<{
  operation: string;
  message: string;
  details: string;
}> {}

export type UpsertSourcePayload = {
  id?: SourceId;
  name: string;
  kind: SourceKind;
  endpoint: string;
  status?: SourceStatus;
  enabled?: boolean;
  configJson?: string;
  sourceHash?: string | null;
  lastError?: string | null;
};

export type UpsertSourceRequest = {
  workspaceId: WorkspaceId;
  payload: UpsertSourcePayload;
  now?: () => number;
};

export type RemoveSourceRequest = {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
};

export type RemoveSourceResult = {
  removed: boolean;
};

export type SourceCatalogService = {
  listSources: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Source>, SourceStoreError>;
  upsertSource: (
    input: UpsertSourceRequest,
  ) => Effect.Effect<Source, SourceStoreError | SourceCatalogValidationError>;
  removeSource: (
    input: RemoveSourceRequest,
  ) => Effect.Effect<RemoveSourceResult, SourceStoreError>;
};

export class SourceCatalog extends Context.Tag("@executor-v2/management-api/SourceCatalog")<
  SourceCatalog,
  SourceCatalogService
>() {}

const decodeSourceId = Schema.decodeUnknown(SourceIdSchema);
const decodeSource = Schema.decodeUnknown(SourceSchema);

const sourceStoreKey = (source: Source): string => `${source.workspaceId}:${source.id}`;

const sortSources = (sources: ReadonlyArray<Source>): Array<Source> =>
  [...sources].sort((left, right) => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName === rightName) {
      return sourceStoreKey(left).localeCompare(sourceStoreKey(right));
    }

    return leftName.localeCompare(rightName);
  });

const toSourceCatalogValidationError = (
  operation: string,
  cause: unknown,
): SourceCatalogValidationError =>
  new SourceCatalogValidationError({
    operation,
    message: "Invalid source payload",
    details: ParseResult.isParseError(cause)
      ? ParseResult.TreeFormatter.formatErrorSync(cause)
      : String(cause),
  });

const createSourceId = (): Effect.Effect<SourceId, SourceCatalogValidationError> =>
  decodeSourceId(`src_${crypto.randomUUID()}`).pipe(
    Effect.mapError((cause) => toSourceCatalogValidationError("sources.upsert.id", cause)),
  );

const timestamp = (clock?: () => number): number => clock?.() ?? Date.now();

export const makeSourceCatalogService = (
  sourceStore: SourceStore,
): SourceCatalogService => ({
  listSources: (workspaceId) =>
    sourceStore.listByWorkspace(workspaceId).pipe(Effect.map(sortSources)),
  upsertSource: (input) =>
    Effect.gen(function* () {
      const sourceId = input.payload.id ?? (yield* createSourceId());
      const now = timestamp(input.now);
      const existingOption = yield* sourceStore.getById(input.workspaceId, sourceId);
      const existing = Option.getOrUndefined(existingOption);

      const source = yield* decodeSource({
        id: sourceId,
        workspaceId: input.workspaceId,
        name: input.payload.name,
        kind: input.payload.kind,
        endpoint: input.payload.endpoint,
        status: input.payload.status ?? "draft",
        enabled: input.payload.enabled ?? true,
        configJson: input.payload.configJson ?? "{}",
        sourceHash: input.payload.sourceHash ?? null,
        lastError: input.payload.lastError ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }).pipe(
        Effect.mapError((cause) =>
          toSourceCatalogValidationError("sources.upsert.payload", cause),
        ),
      );

      yield* sourceStore.upsert(source);
      return source;
    }),
  removeSource: (input) =>
    sourceStore.removeById(input.workspaceId, input.sourceId).pipe(
      Effect.map((removed): RemoveSourceResult => ({ removed })),
    ),
});

export const SourceCatalogLive = Layer.effect(
  SourceCatalog,
  Effect.gen(function* () {
    const sourceStore = yield* SourceStoreService;

    return SourceCatalog.of(makeSourceCatalogService(sourceStore));
  }),
);

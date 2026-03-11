import {
  type McpSourceAuthSessionData,
  type SourceAuthSession,
  type StoredSourceRecipeDocumentRecord,
  type StoredSourceRecord,
} from "#schema";
import {
  JsonObjectSchema,
  McpSourceAuthSessionDataJsonSchema,
} from "#schema";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import { rebuildGraphqlRecipeRevisionContent } from "../runtime/source-adapters/graphql";
import { rebuildOpenApiRecipeRevisionContent } from "../runtime/source-adapters/openapi";
import type { SqlControlPlaneRows } from "./index";

type DataMigration = {
  id: string;
  run: (rows: SqlControlPlaneRows) => Effect.Effect<void, Error, never>;
};

const LegacyMcpSourceAuthSessionDataSchema = Schema.Struct({
  kind: Schema.Literal("mcp_oauth"),
  endpoint: Schema.String,
  redirectUri: Schema.String,
  scope: Schema.NullOr(Schema.String),
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerUrl: Schema.NullOr(Schema.String),
  resourceMetadataJson: Schema.NullOr(Schema.String),
  authorizationServerMetadataJson: Schema.NullOr(Schema.String),
  clientInformationJson: Schema.NullOr(Schema.String),
  codeVerifier: Schema.NullOr(Schema.String),
  authorizationUrl: Schema.NullOr(Schema.String),
});

const decodeLegacyMcpSourceAuthSessionDataJson = Schema.decodeUnknownEither(
  Schema.parseJson(LegacyMcpSourceAuthSessionDataSchema),
);

const decodeMcpSourceAuthSessionDataJson = Schema.decodeUnknownEither(
  McpSourceAuthSessionDataJsonSchema,
);

const encodeMcpSourceAuthSessionDataJson = Schema.encodeSync(
  McpSourceAuthSessionDataJsonSchema,
);

const decodeJsonObjectFromJson = Schema.decodeUnknownEither(
  Schema.parseJson(JsonObjectSchema),
);

const decodeLegacyJsonObject = (value: string | null) => {
  if (value === null) {
    return null;
  }

  const decoded = decodeJsonObjectFromJson(value);
  return Either.isRight(decoded) ? decoded.right : null;
};

const repairLegacyMcpSourceAuthSession = (input: {
  rows: SqlControlPlaneRows;
  session: SourceAuthSession;
}): Effect.Effect<void, never, never> => {
  if (input.session.providerKind !== "mcp_oauth") {
    return Effect.void;
  }

  if (
    Either.isRight(
      decodeMcpSourceAuthSessionDataJson(input.session.sessionDataJson),
    )
  ) {
    return Effect.void;
  }

  const legacy = decodeLegacyMcpSourceAuthSessionDataJson(
    input.session.sessionDataJson,
  );
  if (Either.isLeft(legacy)) {
    console.warn(
      `Skipping source auth session data migration for ${input.session.id}: ${ParseResult.TreeFormatter.formatErrorSync(legacy.left)}`,
    );
    return Effect.void;
  }

  const repaired: McpSourceAuthSessionData = {
    kind: "mcp_oauth",
    endpoint: legacy.right.endpoint,
    redirectUri: legacy.right.redirectUri,
    scope: legacy.right.scope,
    resourceMetadataUrl: legacy.right.resourceMetadataUrl,
    authorizationServerUrl: legacy.right.authorizationServerUrl,
    resourceMetadata: decodeLegacyJsonObject(legacy.right.resourceMetadataJson),
    authorizationServerMetadata: decodeLegacyJsonObject(
      legacy.right.authorizationServerMetadataJson,
    ),
    clientInformation: decodeLegacyJsonObject(
      legacy.right.clientInformationJson,
    ),
    codeVerifier: legacy.right.codeVerifier,
    authorizationUrl: legacy.right.authorizationUrl,
  };

  return input.rows.sourceAuthSessions
    .update(input.session.id, {
      sessionDataJson: encodeMcpSourceAuthSessionDataJson(repaired),
    })
    .pipe(Effect.asVoid, Effect.orDie);
};

const migrateLegacySourceAuthSessions: DataMigration = {
  id: "20260310_repair_legacy_mcp_oauth_sessions",
  run: (rows) =>
    Effect.gen(function* () {
      const sourceAuthSessions = yield* rows.sourceAuthSessions.listAll();
      yield* Effect.forEach(
        sourceAuthSessions,
        (session) =>
          repairLegacyMcpSourceAuthSession({
            rows,
            session,
          }),
        { discard: true },
      );
    }),
};

const rebuildPersistedSourceRecipes: DataMigration = {
  id: "20260310_rebuild_persisted_source_recipes",
  run: (rows) =>
    Effect.gen(function* () {
      const sourceRecords = yield* rows.sources.listAll();
      if (sourceRecords.length === 0) {
        return;
      }

      const revisionIds = [
        ...new Set(sourceRecords.map((sourceRecord) => sourceRecord.recipeRevisionId)),
      ];
      const [revisions, documents] = yield* Effect.all([
        rows.sourceRecipeRevisions.listByIds(revisionIds),
        rows.sourceRecipeDocuments.listByRevisionIds(revisionIds),
      ]);

      const revisionById = new Map(
        revisions.map((revision) => [revision.id, revision]),
      );
      const sourceRecordByRevisionId = new Map<string, StoredSourceRecord>();
      for (const sourceRecord of sourceRecords) {
        if (!sourceRecordByRevisionId.has(sourceRecord.recipeRevisionId)) {
          sourceRecordByRevisionId.set(sourceRecord.recipeRevisionId, sourceRecord);
        }
      }

      const documentsByRevisionId = new Map<string, StoredSourceRecipeDocumentRecord[]>();
      for (const document of documents) {
        const existing = documentsByRevisionId.get(document.recipeRevisionId) ?? [];
        existing.push(document);
        documentsByRevisionId.set(document.recipeRevisionId, existing);
      }

      yield* Effect.forEach(
        revisionIds,
        (revisionId) =>
          Effect.gen(function* () {
            const sourceRecord = sourceRecordByRevisionId.get(revisionId);
            const revision = revisionById.get(revisionId);
            const documentsForRevision = documentsByRevisionId.get(revisionId) ?? [];
            if (!sourceRecord || !revision) {
              return;
            }

            if (sourceRecord.kind === "openapi") {
              if (documentsForRevision.length === 0) {
                return;
              }
              yield* rebuildOpenApiRecipeRevisionContent({
                rows,
                sourceRecord,
                revision,
                documents: documentsForRevision,
              });
              return;
            }

            if (sourceRecord.kind !== "graphql") {
              return;
            }

            if (documentsForRevision.length === 0) {
              return;
            }

            yield* rebuildGraphqlRecipeRevisionContent({
              rows,
              sourceRecord,
              revision,
              documents: documentsForRevision,
            });
          }),
        { discard: true },
      );
    }),
};

const codeMigrations = [
  rebuildPersistedSourceRecipes,
  migrateLegacySourceAuthSessions,
] as const satisfies readonly DataMigration[];

export const runCodeMigrations = (
  rows: SqlControlPlaneRows,
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const applied = new Set(
      (yield* rows.codeMigrations.listAll()).map((migration) => migration.id),
    );

    for (const migration of codeMigrations) {
      if (applied.has(migration.id)) {
        continue;
      }

      yield* migration.run(rows);
      yield* rows.codeMigrations.upsert({
        id: migration.id,
        appliedAt: Date.now(),
      });
    }
  });

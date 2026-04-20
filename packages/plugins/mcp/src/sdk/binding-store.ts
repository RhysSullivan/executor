// ---------------------------------------------------------------------------
// MCP plugin storage — three tables (mcp_source, mcp_binding,
// mcp_oauth_session) using the new declared-schema pattern.
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import {
  defineSchema,
  type StorageDeps,
  type StorageFailure,
} from "@executor/sdk";

import { McpToolBinding, McpStoredSourceData } from "./types";
import { McpOAuthSession } from "./oauth";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const mcpSchema = defineSchema({
  mcp_source: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      config: { type: "json", required: true },
      created_at: { type: "date", required: true },
    },
  },
  mcp_binding: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      binding: { type: "json", required: true },
      created_at: { type: "date", required: true },
    },
  },
  mcp_oauth_session: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      session: { type: "json", required: true },
      expires_at: { type: "number", required: true },
      created_at: { type: "date", required: true },
    },
  },
});

export type McpSchema = typeof mcpSchema;

// ---------------------------------------------------------------------------
// OAuth session TTL
// ---------------------------------------------------------------------------

export const MCP_OAUTH_SESSION_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Serialization helpers — JSON columns round-trip through the adapter as
// either plain objects or serialized strings depending on the backend.
// Use Schema.parseJson so the memory adapter's string round-trip and the
// SQL adapter's JSONB both decode correctly.
// ---------------------------------------------------------------------------

const decodeSourceData = Schema.decodeUnknownSync(McpStoredSourceData);
const encodeSourceData = Schema.encodeSync(McpStoredSourceData);

const decodeBinding = Schema.decodeUnknownSync(McpToolBinding);
const encodeBinding = Schema.encodeSync(McpToolBinding);

const decodeSession = Schema.decodeUnknownSync(McpOAuthSession);
const encodeSession = Schema.encodeSync(McpOAuthSession);

const coerceJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

// ---------------------------------------------------------------------------
// Stored source (decoded) — what callers see
// ---------------------------------------------------------------------------

export interface McpStoredSource {
  readonly namespace: string;
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads return whichever scope's row the adapter's
   *  fall-through walk surfaced first. */
  readonly scope: string;
  readonly name: string;
  readonly config: McpStoredSourceData;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

// Every method routes through the typed adapter (`ctx.storage.adapter`)
// so the typed error channel is `StorageFailure`. Schema-decode failures
// inside `Effect.gen` land as defects, not typed errors, and are caught
// by the HTTP edge's observability middleware.
export interface McpBindingStore {
  readonly getBinding: (
    toolId: string,
  ) => Effect.Effect<
    { readonly binding: McpToolBinding; readonly namespace: string } | null,
    StorageFailure
  >;

  readonly putBindings: (
    namespace: string,
    scope: string,
    entries: ReadonlyArray<{ readonly toolId: string; readonly binding: McpToolBinding }>,
  ) => Effect.Effect<void, StorageFailure>;

  readonly removeBindingsByNamespace: (
    namespace: string,
  ) => Effect.Effect<void, StorageFailure>;

  readonly listSources: () => Effect.Effect<readonly McpStoredSource[], StorageFailure>;
  readonly getSource: (
    namespace: string,
  ) => Effect.Effect<McpStoredSource | null, StorageFailure>;
  readonly getSourceConfig: (
    namespace: string,
  ) => Effect.Effect<McpStoredSourceData | null, StorageFailure>;
  readonly putSource: (source: McpStoredSource) => Effect.Effect<void, StorageFailure>;
  readonly removeSource: (namespace: string) => Effect.Effect<void, StorageFailure>;

  readonly putOAuthSession: (
    sessionId: string,
    scope: string,
    session: McpOAuthSession,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getOAuthSession: (
    sessionId: string,
  ) => Effect.Effect<McpOAuthSession | null, StorageFailure>;
  readonly deleteOAuthSession: (sessionId: string) => Effect.Effect<void, StorageFailure>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const makeMcpStore = ({
  adapter: db,
}: StorageDeps<McpSchema>): McpBindingStore => {
  return {
    getBinding: (toolId) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "mcp_binding",
          where: [{ field: "id", value: toolId }],
        });
        if (!row) return null;
        const binding = decodeBinding(coerceJson(row.binding));
        return { binding, namespace: row.source_id };
      }),

    putBindings: (namespace, scope, entries) =>
      Effect.gen(function* () {
        if (entries.length === 0) return;
        const now = new Date();
        yield* db.createMany({
          model: "mcp_binding",
          data: entries.map((e) => ({
            id: e.toolId,
            scope_id: scope,
            source_id: namespace,
            binding: encodeBinding(e.binding),
            created_at: now,
          })),
          forceAllowId: true,
        });
      }),

    removeBindingsByNamespace: (namespace) =>
      db
        .deleteMany({
          model: "mcp_binding",
          where: [{ field: "source_id", value: namespace }],
        })
        .pipe(Effect.asVoid),

    listSources: () =>
      Effect.gen(function* () {
        const rows = yield* db.findMany({ model: "mcp_source" });
        return rows.map((row) => ({
          namespace: row.id,
          scope: row.scope_id,
          name: row.name,
          config: decodeSourceData(coerceJson(row.config)),
        }));
      }),

    getSource: (namespace) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "mcp_source",
          where: [{ field: "id", value: namespace }],
        });
        if (!row) return null;
        return {
          namespace: row.id,
          scope: row.scope_id,
          name: row.name,
          config: decodeSourceData(coerceJson(row.config)),
        };
      }),

    getSourceConfig: (namespace) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "mcp_source",
          where: [{ field: "id", value: namespace }],
        });
        if (!row) return null;
        return decodeSourceData(coerceJson(row.config));
      }),

    putSource: (source) =>
      Effect.gen(function* () {
        const now = new Date();
        yield* db.delete({
          model: "mcp_source",
          where: [{ field: "id", value: source.namespace }],
        });
        yield* db.create({
          model: "mcp_source",
          data: {
            id: source.namespace,
            scope_id: source.scope,
            name: source.name,
            config: encodeSourceData(source.config),
            created_at: now,
          },
          forceAllowId: true,
        });
      }),

    removeSource: (namespace) =>
      Effect.gen(function* () {
        yield* db.deleteMany({
          model: "mcp_binding",
          where: [{ field: "source_id", value: namespace }],
        });
        yield* db.delete({
          model: "mcp_source",
          where: [{ field: "id", value: namespace }],
        });
      }),

    putOAuthSession: (sessionId, scope, session) =>
      Effect.gen(function* () {
        const now = new Date();
        yield* db.delete({
          model: "mcp_oauth_session",
          where: [{ field: "id", value: sessionId }],
        });
        yield* db.create({
          model: "mcp_oauth_session",
          data: {
            id: sessionId,
            scope_id: scope,
            session: encodeSession(session),
            expires_at: Date.now() + MCP_OAUTH_SESSION_TTL_MS,
            created_at: now,
          },
          forceAllowId: true,
        });
      }),

    getOAuthSession: (sessionId) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "mcp_oauth_session",
          where: [{ field: "id", value: sessionId }],
        });
        if (!row) return null;
        if (row.expires_at < Date.now()) {
          yield* db.delete({
            model: "mcp_oauth_session",
            where: [{ field: "id", value: sessionId }],
          });
          return null;
        }
        return decodeSession(coerceJson(row.session));
      }),

    deleteOAuthSession: (sessionId) =>
      db
        .delete({
          model: "mcp_oauth_session",
          where: [{ field: "id", value: sessionId }],
        })
        .pipe(Effect.asVoid),
  };
};

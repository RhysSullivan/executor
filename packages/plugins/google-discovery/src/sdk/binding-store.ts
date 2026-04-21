// ---------------------------------------------------------------------------
// Google Discovery plugin store — typed adapter over the plugin's own
// schema. Replaces the old ScopedKv-backed binding store. Operates on
// three tables:
//
//   google_discovery_source         — per-namespace source config blob
//   google_discovery_binding        — per-tool-id method binding
//   google_discovery_oauth_session  — short-lived OAuth PKCE sessions
//
// All JSON columns are round-tripped via Schema.encode/decode so `Option`
// shapes inside GoogleDiscoveryStoredSourceData / GoogleDiscoveryMethodBinding
// survive adapter serialization.
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import {
  defineSchema,
  type StorageDeps,
  type StorageFailure,
} from "@executor/sdk";

import {
  GoogleDiscoveryMethodBinding,
  GoogleDiscoveryOAuthSession,
  GoogleDiscoveryStoredSourceData,
} from "./types";

// ---------------------------------------------------------------------------
// OAuth session TTL
// ---------------------------------------------------------------------------

export const GOOGLE_DISCOVERY_OAUTH_SESSION_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Schema — plugin-declared tables merged with coreSchema at executor start.
// ---------------------------------------------------------------------------

export const googleDiscoverySchema = defineSchema({
  google_discovery_source: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      config: { type: "json", required: true },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  google_discovery_binding: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      binding: { type: "json", required: true },
      created_at: { type: "date", required: true },
    },
  },
  google_discovery_oauth_session: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      session: { type: "json", required: true },
      expires_at: { type: "date", required: true },
    },
  },
});

export type GoogleDiscoverySchema = typeof googleDiscoverySchema;

// ---------------------------------------------------------------------------
// Stored source projection for the extension API.
// ---------------------------------------------------------------------------

export interface GoogleDiscoveryStoredSource {
  readonly namespace: string;
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads return whichever scope's row the adapter's
   *  fall-through walk surfaced first. */
  readonly scope: string;
  readonly name: string;
  readonly config: GoogleDiscoveryStoredSourceData;
}

// ---------------------------------------------------------------------------
// Schema encode/decode for JSON columns so Option round-trips properly.
// ---------------------------------------------------------------------------

const encodeStoredSourceData = Schema.encodeSync(GoogleDiscoveryStoredSourceData);
const decodeStoredSourceData = Schema.decodeUnknownSync(GoogleDiscoveryStoredSourceData);

const encodeBinding = Schema.encodeSync(GoogleDiscoveryMethodBinding);
const decodeBinding = Schema.decodeUnknownSync(GoogleDiscoveryMethodBinding);

const encodeSession = Schema.encodeSync(GoogleDiscoveryOAuthSession);
const decodeSession = Schema.decodeUnknownSync(GoogleDiscoveryOAuthSession);

const decodeJson = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

// Every method routes through the typed adapter (`ctx.storage.adapter`)
// so the typed error channel is `StorageFailure`. Schema-decode failures
// inside `Effect.gen` land as defects, not typed errors, and are caught
// by the HTTP edge's observability middleware.
//
// Every read/write that targets a single keyed row pins BOTH the natural
// id (toolId, sourceId, sessionId) AND the owning `scope_id`. The store
// runs behind the scoped adapter (which auto-injects `scope_id IN
// (stack)`), so a bare `{id}` filter resolves to any matching row in the
// stack in adapter-iteration order. For shadowed rows (same id at
// multiple scopes — e.g. an org-level google discovery source with a
// per-user override), that's a scope-isolation bug: updates and deletes
// can land on the wrong scope's row. Callers thread the resolved scope
// in (typically `path.scopeId` for HTTP, `toolRow.scope_id` /
// `input.scope` for invokeTool/lifecycle) so every keyed mutation
// targets exactly one row.
export interface GoogleDiscoveryStore {
  readonly getBinding: (
    toolId: string,
    scope: string,
  ) => Effect.Effect<
    { readonly namespace: string; readonly binding: GoogleDiscoveryMethodBinding } | null,
    StorageFailure
  >;
  readonly putBinding: (
    toolId: string,
    sourceId: string,
    scope: string,
    binding: GoogleDiscoveryMethodBinding,
  ) => Effect.Effect<void, StorageFailure>;
  readonly removeBindingsBySource: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<readonly string[], StorageFailure>;
  readonly getBindingsForSource: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<
    ReadonlyMap<string, GoogleDiscoveryMethodBinding>,
    StorageFailure
  >;

  readonly putSource: (
    source: GoogleDiscoveryStoredSource,
  ) => Effect.Effect<void, StorageFailure>;
  readonly updateSourceMeta: (
    sourceId: string,
    scope: string,
    update: {
      readonly name?: string;
      readonly auth?: import("./types").GoogleDiscoveryAuth;
    },
  ) => Effect.Effect<void, StorageFailure>;
  readonly removeSource: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getSource: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<GoogleDiscoveryStoredSource | null, StorageFailure>;
  readonly getSourceConfig: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<GoogleDiscoveryStoredSourceData | null, StorageFailure>;

  readonly putOAuthSession: (
    sessionId: string,
    scope: string,
    session: GoogleDiscoveryOAuthSession,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getOAuthSession: (
    sessionId: string,
  ) => Effect.Effect<GoogleDiscoveryOAuthSession | null, StorageFailure>;
  readonly deleteOAuthSession: (sessionId: string) => Effect.Effect<void, StorageFailure>;
}

// ---------------------------------------------------------------------------
// Default store
// ---------------------------------------------------------------------------

export const makeGoogleDiscoveryStore = (
  deps: StorageDeps<GoogleDiscoverySchema>,
): GoogleDiscoveryStore => {
  const db = deps.adapter;

  return {
    getBinding: (toolId, scope) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "google_discovery_binding",
          where: [
            { field: "id", value: toolId },
            { field: "scope_id", value: scope },
          ],
        });
        if (!row) return null;
        const decoded = decodeBinding(decodeJson(row.binding));
        return { namespace: row.source_id as string, binding: decoded };
      }),

    putBinding: (toolId, sourceId, scope, binding) =>
      Effect.gen(function* () {
        // Upsert: delete + insert. The in-memory adapter accepts
        // overwriting via create; real SQL backends would fail without
        // the explicit delete. Pin the delete to the target scope so a
        // shadowed row at another scope in the stack isn't wiped.
        yield* db.delete({
          model: "google_discovery_binding",
          where: [
            { field: "id", value: toolId },
            { field: "scope_id", value: scope },
          ],
        });
        yield* db.create({
          model: "google_discovery_binding",
          data: {
            id: toolId,
            scope_id: scope,
            source_id: sourceId,
            binding: encodeBinding(binding) as unknown as Record<string, unknown>,
            created_at: new Date(),
          },
          forceAllowId: true,
        });
      }),

    removeBindingsBySource: (sourceId, scope) =>
      Effect.gen(function* () {
        const rows = yield* db.findMany({
          model: "google_discovery_binding",
          where: [
            { field: "source_id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        });
        const ids = rows.map((r) => r.id as string);
        yield* db.deleteMany({
          model: "google_discovery_binding",
          where: [
            { field: "source_id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        });
        return ids;
      }),

    getBindingsForSource: (sourceId, scope) =>
      Effect.gen(function* () {
        const rows = yield* db.findMany({
          model: "google_discovery_binding",
          where: [
            { field: "source_id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        });
        const out = new Map<string, GoogleDiscoveryMethodBinding>();
        for (const row of rows) {
          out.set(row.id as string, decodeBinding(decodeJson(row.binding)));
        }
        return out;
      }),

    putSource: (source) =>
      Effect.gen(function* () {
        const now = new Date();
        yield* db.delete({
          model: "google_discovery_source",
          where: [
            { field: "id", value: source.namespace },
            { field: "scope_id", value: source.scope },
          ],
        });
        yield* db.create({
          model: "google_discovery_source",
          data: {
            id: source.namespace,
            scope_id: source.scope,
            name: source.name,
            config: encodeStoredSourceData(source.config) as unknown as Record<string, unknown>,
            created_at: now,
            updated_at: now,
          },
          forceAllowId: true,
        });
      }),

    updateSourceMeta: (sourceId, scope, update) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "google_discovery_source",
          where: [
            { field: "id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        });
        if (!row) return;
        const config = decodeStoredSourceData(decodeJson(row.config));
        const nextConfig = new GoogleDiscoveryStoredSourceData({
          ...config,
          name: update.name ?? config.name,
          auth: update.auth ?? config.auth,
        });
        yield* db.update({
          model: "google_discovery_source",
          where: [
            { field: "id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
          update: {
            name: update.name ?? (row.name as string),
            config: encodeStoredSourceData(nextConfig) as unknown as Record<string, unknown>,
            updated_at: new Date(),
          },
        });
      }),

    removeSource: (sourceId, scope) =>
      db
        .delete({
          model: "google_discovery_source",
          where: [
            { field: "id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.asVoid),

    getSource: (sourceId, scope) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "google_discovery_source",
          where: [
            { field: "id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        });
        if (!row) return null;
        return {
          namespace: row.id as string,
          scope: row.scope_id as string,
          name: row.name as string,
          config: decodeStoredSourceData(decodeJson(row.config)),
        };
      }),

    getSourceConfig: (sourceId, scope) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "google_discovery_source",
          where: [
            { field: "id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        });
        if (!row) return null;
        return decodeStoredSourceData(decodeJson(row.config));
      }),

    putOAuthSession: (sessionId, scope, session) =>
      Effect.gen(function* () {
        // Pin the defensive overwrite to the target scope — sessionIds
        // are UUIDs so collisions are negligible, but a hypothetical
        // collision with a session in another scope of this stack
        // shouldn't wipe the wrong row.
        yield* db.delete({
          model: "google_discovery_oauth_session",
          where: [
            { field: "id", value: sessionId },
            { field: "scope_id", value: scope },
          ],
        });
        yield* db.create({
          model: "google_discovery_oauth_session",
          data: {
            id: sessionId,
            scope_id: scope,
            session: encodeSession(session) as unknown as Record<string, unknown>,
            expires_at: new Date(Date.now() + GOOGLE_DISCOVERY_OAUTH_SESSION_TTL_MS),
          },
          forceAllowId: true,
        });
      }),

    getOAuthSession: (sessionId) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "google_discovery_oauth_session",
          where: [{ field: "id", value: sessionId }],
        });
        if (!row) return null;
        const expiresAt =
          row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at as string);
        if (expiresAt.getTime() < Date.now()) {
          yield* db.delete({
            model: "google_discovery_oauth_session",
            where: [
              { field: "id", value: sessionId },
              { field: "scope_id", value: row.scope_id as string },
            ],
          });
          return null;
        }
        return decodeSession(decodeJson(row.session));
      }),

    deleteOAuthSession: (sessionId) =>
      db
        .delete({
          model: "google_discovery_oauth_session",
          where: [{ field: "id", value: sessionId }],
        })
        .pipe(Effect.asVoid),
  };
};

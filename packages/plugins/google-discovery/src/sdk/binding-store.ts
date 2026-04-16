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

import { defineSchema, type StorageDeps } from "@executor/sdk";

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

export interface GoogleDiscoveryStore {
  readonly getBinding: (toolId: string) => Effect.Effect<
    { readonly namespace: string; readonly binding: GoogleDiscoveryMethodBinding } | null,
    Error
  >;
  readonly putBinding: (
    toolId: string,
    sourceId: string,
    binding: GoogleDiscoveryMethodBinding,
  ) => Effect.Effect<void, Error>;
  readonly removeBindingsBySource: (
    sourceId: string,
  ) => Effect.Effect<readonly string[], Error>;
  readonly getBindingsForSource: (
    sourceId: string,
  ) => Effect.Effect<
    ReadonlyMap<string, GoogleDiscoveryMethodBinding>,
    Error
  >;

  readonly putSource: (source: GoogleDiscoveryStoredSource) => Effect.Effect<void, Error>;
  readonly removeSource: (sourceId: string) => Effect.Effect<void, Error>;
  readonly getSource: (
    sourceId: string,
  ) => Effect.Effect<GoogleDiscoveryStoredSource | null, Error>;
  readonly getSourceConfig: (
    sourceId: string,
  ) => Effect.Effect<GoogleDiscoveryStoredSourceData | null, Error>;

  readonly putOAuthSession: (
    sessionId: string,
    session: GoogleDiscoveryOAuthSession,
  ) => Effect.Effect<void, Error>;
  readonly getOAuthSession: (
    sessionId: string,
  ) => Effect.Effect<GoogleDiscoveryOAuthSession | null, Error>;
  readonly deleteOAuthSession: (sessionId: string) => Effect.Effect<void, Error>;
}

// ---------------------------------------------------------------------------
// Default store
// ---------------------------------------------------------------------------

export const makeGoogleDiscoveryStore = (
  deps: StorageDeps<GoogleDiscoverySchema>,
): GoogleDiscoveryStore => {
  const db = deps.adapter;

  return {
    getBinding: (toolId) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "google_discovery_binding",
          where: [{ field: "id", value: toolId }],
        });
        if (!row) return null;
        const decoded = decodeBinding(decodeJson(row.binding));
        return { namespace: row.source_id as string, binding: decoded };
      }),

    putBinding: (toolId, sourceId, binding) =>
      Effect.gen(function* () {
        // Upsert: delete + insert. The in-memory adapter accepts
        // overwriting via create; real SQL backends would fail without
        // the explicit delete.
        yield* db.delete({
          model: "google_discovery_binding",
          where: [{ field: "id", value: toolId }],
        });
        yield* db.create({
          model: "google_discovery_binding",
          data: {
            id: toolId,
            source_id: sourceId,
            binding: encodeBinding(binding) as unknown as Record<string, unknown>,
            created_at: new Date(),
          },
          forceAllowId: true,
        });
      }),

    removeBindingsBySource: (sourceId) =>
      Effect.gen(function* () {
        const rows = yield* db.findMany({
          model: "google_discovery_binding",
          where: [{ field: "source_id", value: sourceId }],
        });
        const ids = rows.map((r) => r.id as string);
        yield* db.deleteMany({
          model: "google_discovery_binding",
          where: [{ field: "source_id", value: sourceId }],
        });
        return ids;
      }),

    getBindingsForSource: (sourceId) =>
      Effect.gen(function* () {
        const rows = yield* db.findMany({
          model: "google_discovery_binding",
          where: [{ field: "source_id", value: sourceId }],
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
          where: [{ field: "id", value: source.namespace }],
        });
        yield* db.create({
          model: "google_discovery_source",
          data: {
            id: source.namespace,
            name: source.name,
            config: encodeStoredSourceData(source.config) as unknown as Record<string, unknown>,
            created_at: now,
            updated_at: now,
          },
          forceAllowId: true,
        });
      }),

    removeSource: (sourceId) =>
      db
        .delete({
          model: "google_discovery_source",
          where: [{ field: "id", value: sourceId }],
        })
        .pipe(Effect.asVoid),

    getSource: (sourceId) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "google_discovery_source",
          where: [{ field: "id", value: sourceId }],
        });
        if (!row) return null;
        return {
          namespace: row.id as string,
          name: row.name as string,
          config: decodeStoredSourceData(decodeJson(row.config)),
        };
      }),

    getSourceConfig: (sourceId) =>
      Effect.gen(function* () {
        const row = yield* db.findOne({
          model: "google_discovery_source",
          where: [{ field: "id", value: sourceId }],
        });
        if (!row) return null;
        return decodeStoredSourceData(decodeJson(row.config));
      }),

    putOAuthSession: (sessionId, session) =>
      Effect.gen(function* () {
        yield* db.delete({
          model: "google_discovery_oauth_session",
          where: [{ field: "id", value: sessionId }],
        });
        yield* db.create({
          model: "google_discovery_oauth_session",
          data: {
            id: sessionId,
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
            where: [{ field: "id", value: sessionId }],
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

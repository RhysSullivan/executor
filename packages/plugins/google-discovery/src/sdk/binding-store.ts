// ---------------------------------------------------------------------------
// Google Discovery plugin store — typed adapter over the plugin's own
// schema. Operates on two tables:
//
//   google_discovery_source         — per-namespace source config blob
//   google_discovery_binding        — per-tool-id method binding
//
// OAuth session storage lives at the core level in `oauth2_session` and
// is owned by `ctx.oauth`.
//
// All JSON columns are round-tripped via Schema.encode/decode so `Option`
// shapes inside GoogleDiscoveryStoredSourceData / GoogleDiscoveryMethodBinding
// survive adapter serialization.
// ---------------------------------------------------------------------------

import { Effect, Option, Schema } from "effect";

import { defineSchema, type StorageDeps, type StorageFailure } from "@executor-js/sdk/core";

import {
  GoogleDiscoveryMethodBinding,
  GoogleDiscoveryStoredSourceData,
  type GoogleDiscoveryAuth,
  type GoogleDiscoveryCredentialValue,
  type GoogleDiscoveryFetchCredentials,
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
      // Plugin-private structural config minus auth/credentials —
      // discoveryUrl, service, version, rootUrl, servicePath. These
      // never carry refs.
      config: { type: "json", required: true },
      // Flattened GoogleDiscoveryAuth.
      auth_kind: {
        type: ["none", "oauth2"],
        required: true,
        defaultValue: "none",
      },
      auth_connection_id: { type: "string", required: false, index: true },
      auth_client_id_secret_id: {
        type: "string",
        required: false,
        index: true,
      },
      auth_client_secret_secret_id: {
        type: "string",
        required: false,
        index: true,
      },
      // Stored as a string[] (JSON-backed but not a ref-bearing column).
      // Empty array when auth_kind is "none".
      auth_scopes: { type: "string[]", required: false },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  google_discovery_source_credential_header: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      kind: { type: ["text", "secret"], required: true },
      text_value: { type: "string", required: false },
      secret_id: { type: "string", required: false, index: true },
      secret_prefix: { type: "string", required: false },
    },
  },
  google_discovery_source_credential_query_param: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      kind: { type: ["text", "secret"], required: true },
      text_value: { type: "string", required: false },
      secret_id: { type: "string", required: false, index: true },
      secret_prefix: { type: "string", required: false },
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

const toJsonRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const decodeString = Schema.decodeUnknownSync(Schema.String);
const decodeJsonObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const decodeJson = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return value;
  return Option.getOrElse(decodeJsonString(value), () => value);
};

// --- auth column packing/unpacking ------------------------------------------

interface AuthColumns {
  readonly auth_kind: "none" | "oauth2";
  readonly auth_connection_id?: string;
  readonly auth_client_id_secret_id?: string;
  readonly auth_client_secret_secret_id?: string;
  // Mutable rather than readonly so the typed adapter's RowInput shape
  // (which expects `string[]`, not `readonly string[]`) is satisfied.
  readonly auth_scopes?: string[];
}

const authToColumns = (auth: GoogleDiscoveryAuth): AuthColumns => {
  if (auth.kind === "oauth2") {
    return {
      auth_kind: "oauth2",
      auth_connection_id: auth.connectionId,
      auth_client_id_secret_id: auth.clientIdSecretId,
      auth_client_secret_secret_id: auth.clientSecretSecretId ?? undefined,
      auth_scopes: [...auth.scopes],
    };
  }
  return { auth_kind: "none" };
};

const columnsToAuth = (row: Record<string, unknown>): GoogleDiscoveryAuth => {
  if (
    row.auth_kind === "oauth2" &&
    typeof row.auth_connection_id === "string" &&
    typeof row.auth_client_id_secret_id === "string"
  ) {
    const csec = row.auth_client_secret_secret_id as string | null | undefined;
    const scopes = (row.auth_scopes as readonly string[] | null | undefined) ?? [];
    return {
      kind: "oauth2",
      connectionId: row.auth_connection_id,
      clientIdSecretId: row.auth_client_id_secret_id,
      clientSecretSecretId: csec ?? null,
      scopes: [...scopes],
    };
  }
  return { kind: "none" };
};

// --- SecretBackedValue maps <-> child rows ----------------------------------

interface CredentialRow {
  readonly id: string;
  readonly scope_id: string;
  readonly source_id: string;
  readonly name: string;
  readonly kind: "text" | "secret";
  readonly text_value?: string;
  readonly secret_id?: string;
  readonly secret_prefix?: string;
  readonly [k: string]: unknown;
}

const valueMapToRows = (
  sourceId: string,
  scope: string,
  values: Record<string, GoogleDiscoveryCredentialValue> | undefined,
): readonly CredentialRow[] => {
  if (!values) return [];
  return Object.entries(values).map(([name, value]) => {
    const id = JSON.stringify([sourceId, name]);
    if (typeof value === "string") {
      return {
        id,
        scope_id: scope,
        source_id: sourceId,
        name,
        kind: "text",
        text_value: value,
      };
    }
    return {
      id,
      scope_id: scope,
      source_id: sourceId,
      name,
      kind: "secret",
      secret_id: value.secretId,
      secret_prefix: value.prefix,
    };
  });
};

const rowsToValueMap = (
  rows: readonly Record<string, unknown>[],
): Record<string, GoogleDiscoveryCredentialValue> => {
  const out: Record<string, GoogleDiscoveryCredentialValue> = {};
  for (const row of rows) {
    const name = decodeString(row.name);
    if (row.kind === "secret" && typeof row.secret_id === "string") {
      const prefix = row.secret_prefix as string | undefined | null;
      out[name] = prefix ? { secretId: row.secret_id, prefix } : { secretId: row.secret_id };
    } else if (row.kind === "text" && typeof row.text_value === "string") {
      out[name] = row.text_value;
    }
  }
  return out;
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
  ) => Effect.Effect<ReadonlyMap<string, GoogleDiscoveryMethodBinding>, StorageFailure>;

  readonly putSource: (source: GoogleDiscoveryStoredSource) => Effect.Effect<void, StorageFailure>;
  readonly updateSourceMeta: (
    sourceId: string,
    scope: string,
    update: {
      readonly name?: string;
      readonly auth?: import("./types").GoogleDiscoveryAuth;
    },
  ) => Effect.Effect<void, StorageFailure>;
  readonly removeSource: (sourceId: string, scope: string) => Effect.Effect<void, StorageFailure>;
  readonly getSource: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<GoogleDiscoveryStoredSource | null, StorageFailure>;
  readonly getSourceConfig: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<GoogleDiscoveryStoredSourceData | null, StorageFailure>;

  // ---------------------------------------------------------------------
  // Usage lookups — back `usagesForSecret` / `usagesForConnection`.
  // ---------------------------------------------------------------------

  /** Source rows whose oauth2 auth columns reference the given secret id.
   *  `slot` distinguishes client_id vs client_secret. */
  readonly findSourcesBySecret: (secretId: string) => Effect.Effect<
    readonly {
      readonly namespace: string;
      readonly scope_id: string;
      readonly name: string;
      readonly slot: string;
    }[],
    StorageFailure
  >;

  /** Source rows whose oauth2 auth points at the given connection id. */
  readonly findSourcesByConnection: (connectionId: string) => Effect.Effect<
    readonly {
      readonly namespace: string;
      readonly scope_id: string;
      readonly name: string;
      readonly slot: string;
    }[],
    StorageFailure
  >;

  /** Credential header / query_param child rows referencing the secret. */
  readonly findCredentialRowsBySecret: (secretId: string) => Effect.Effect<
    readonly {
      readonly kind: "credential_header" | "credential_query_param";
      readonly source_id: string;
      readonly scope_id: string;
      readonly name: string;
    }[],
    StorageFailure
  >;

  readonly lookupSourceNames: (
    keys: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, string>, StorageFailure>;
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
        return { namespace: decodeString(row.source_id), binding: decoded };
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
            binding: toJsonRecord(encodeBinding(binding)),
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
        const ids = rows.map((r) => decodeString(r.id));
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
          out.set(decodeString(row.id), decodeBinding(decodeJson(row.binding)));
        }
        return out;
      }),

    putSource: (source) =>
      Effect.gen(function* () {
        const now = new Date();
        // Wipe the source row + every child row before recreating —
        // matches putSource's "fully replace" semantic.
        yield* db.delete({
          model: "google_discovery_source",
          where: [
            { field: "id", value: source.namespace },
            { field: "scope_id", value: source.scope },
          ],
        });
        yield* deleteSourceChildren(source.namespace, source.scope);

        const encoded = stripExtractedFields(
          decodeJsonObject(encodeStoredSourceData(source.config)),
        );
        yield* db.create({
          model: "google_discovery_source",
          data: {
            id: source.namespace,
            scope_id: source.scope,
            name: source.name,
            config: toJsonRecord(encoded),
            created_at: now,
            updated_at: now,
            ...authToColumns(source.config.auth),
          },
          forceAllowId: true,
        });
        yield* writeCredentialRows(source.namespace, source.scope, source.config.credentials);
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
        const auth = update.auth ?? columnsToAuth(row);
        yield* db.update({
          model: "google_discovery_source",
          where: [
            { field: "id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
          update: {
            name: update.name ?? decodeString(row.name),
            updated_at: new Date(),
            ...authToColumns(auth),
          },
        });
      }),

    removeSource: (sourceId, scope) =>
      Effect.gen(function* () {
        yield* deleteSourceChildren(sourceId, scope);
        yield* db.delete({
          model: "google_discovery_source",
          where: [
            { field: "id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        });
      }),

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
          namespace: decodeString(row.id),
          scope: decodeString(row.scope_id),
          name: decodeString(row.name),
          config: yield* hydrateStoredSourceData(row, sourceId, scope),
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
        return yield* hydrateStoredSourceData(row, sourceId, scope);
      }),

    findSourcesBySecret: (secretId) =>
      Effect.gen(function* () {
        const [byClientId, byClientSecret] = yield* Effect.all(
          [
            db.findMany({
              model: "google_discovery_source",
              where: [{ field: "auth_client_id_secret_id", value: secretId }],
            }),
            db.findMany({
              model: "google_discovery_source",
              where: [{ field: "auth_client_secret_secret_id", value: secretId }],
            }),
          ],
          { concurrency: "unbounded" },
        );
        const out: {
          readonly namespace: string;
          readonly scope_id: string;
          readonly name: string;
          readonly slot: string;
        }[] = [];
        for (const r of byClientId) {
          out.push({
            namespace: decodeString(r.id),
            scope_id: decodeString(r.scope_id),
            name: decodeString(r.name),
            slot: "auth.oauth2.client_id",
          });
        }
        for (const r of byClientSecret) {
          out.push({
            namespace: decodeString(r.id),
            scope_id: decodeString(r.scope_id),
            name: decodeString(r.name),
            slot: "auth.oauth2.client_secret",
          });
        }
        return out;
      }),

    findSourcesByConnection: (connectionId) =>
      db
        .findMany({
          model: "google_discovery_source",
          where: [{ field: "auth_connection_id", value: connectionId }],
        })
        .pipe(
          Effect.map((rows) =>
            rows.map((r) => ({
              namespace: decodeString(r.id),
              scope_id: decodeString(r.scope_id),
              name: decodeString(r.name),
              slot: "auth.oauth2.connection",
            })),
          ),
        ),

    findCredentialRowsBySecret: (secretId) =>
      Effect.gen(function* () {
        const [headers, params] = yield* Effect.all(
          [
            db.findMany({
              model: "google_discovery_source_credential_header",
              where: [{ field: "secret_id", value: secretId }],
            }),
            db.findMany({
              model: "google_discovery_source_credential_query_param",
              where: [{ field: "secret_id", value: secretId }],
            }),
          ],
          { concurrency: "unbounded" },
        );
        return [
          ...headers.map((r) => ({
            kind: "credential_header" as const,
            source_id: decodeString(r.source_id),
            scope_id: decodeString(r.scope_id),
            name: decodeString(r.name),
          })),
          ...params.map((r) => ({
            kind: "credential_query_param" as const,
            source_id: decodeString(r.source_id),
            scope_id: decodeString(r.scope_id),
            name: decodeString(r.name),
          })),
        ];
      }),

    lookupSourceNames: (keys) =>
      Effect.gen(function* () {
        if (keys.length === 0) return new Map<string, string>();
        const rows = yield* db.findMany({ model: "google_discovery_source" });
        const requested = new Set(keys);
        const out = new Map<string, string>();
        for (const r of rows) {
          const key = `${decodeString(r.scope_id)}:${decodeString(r.id)}`;
          if (requested.has(key)) out.set(key, decodeString(r.name));
        }
        return out;
      }),
  };

  // ---------------------------------------------------------------------
  // Closure helpers (depend on `db`).
  // ---------------------------------------------------------------------

  function deleteSourceChildren(sourceId: string, scope: string) {
    // Drop only credential child rows. Bindings live independently and
    // are managed via putBinding / removeBindingsBySource — wiping them
    // here would break putSource (which legitimately keeps existing
    // bindings) and the test for "registers and invokes ... tools".
    return Effect.gen(function* () {
      for (const model of [
        "google_discovery_source_credential_header",
        "google_discovery_source_credential_query_param",
      ] as const) {
        yield* db.deleteMany({
          model,
          where: [
            { field: "source_id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        });
      }
    });
  }

  function writeCredentialRows(
    sourceId: string,
    scope: string,
    credentials: GoogleDiscoveryFetchCredentials | undefined,
  ) {
    return Effect.gen(function* () {
      if (!credentials) return;
      const headerRows = valueMapToRows(sourceId, scope, credentials.headers);
      if (headerRows.length > 0) {
        yield* db.createMany({
          model: "google_discovery_source_credential_header",
          data: headerRows,
          forceAllowId: true,
        });
      }
      const paramRows = valueMapToRows(sourceId, scope, credentials.queryParams);
      if (paramRows.length > 0) {
        yield* db.createMany({
          model: "google_discovery_source_credential_query_param",
          data: paramRows,
          forceAllowId: true,
        });
      }
    });
  }

  function hydrateStoredSourceData(
    row: Record<string, unknown>,
    sourceId: string,
    scope: string,
  ): Effect.Effect<GoogleDiscoveryStoredSourceData, StorageFailure> {
    return Effect.gen(function* () {
      const partial = decodeJsonObject(decodeJson(row.config));
      const headerRows = yield* db.findMany({
        model: "google_discovery_source_credential_header",
        where: [
          { field: "source_id", value: sourceId },
          { field: "scope_id", value: scope },
        ],
      });
      const paramRows = yield* db.findMany({
        model: "google_discovery_source_credential_query_param",
        where: [
          { field: "source_id", value: sourceId },
          { field: "scope_id", value: scope },
        ],
      });
      const headers = rowsToValueMap(headerRows);
      const queryParams = rowsToValueMap(paramRows);
      const credentials =
        Object.keys(headers).length === 0 && Object.keys(queryParams).length === 0
          ? undefined
          : {
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
              ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
            };
      const reassembled = {
        ...partial,
        auth: columnsToAuth(row),
        ...(credentials ? { credentials } : {}),
      };
      return decodeStoredSourceData(reassembled);
    });
  }
};

// Strip auth/credentials from the encoded source-data shape. Those
// moved to columns and child tables; the remaining structural fields
// live in the `config` JSON.
const stripExtractedFields = (encoded: Record<string, unknown>): Record<string, unknown> => {
  const { auth, credentials, ...rest } = encoded;
  void auth;
  void credentials;
  return rest;
};

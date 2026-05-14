// ---------------------------------------------------------------------------
// Google Discovery plugin store over FumaDB. Operates on two primary tables:
//
//   google_discovery_source         — per-namespace source config blob
//   google_discovery_binding        — per-tool-id method binding
//
// OAuth session storage lives at the core level in `oauth2_session` and
// is owned by `ctx.oauth`.
//
// All JSON columns are round-tripped via Schema.encode/decode so `Option`
// shapes inside GoogleDiscoveryStoredSourceData / GoogleDiscoveryMethodBinding
// survive storage serialization.
// ---------------------------------------------------------------------------

import { Effect, Option, Schema } from "effect";

import {
  dateColumn,
  type FumaTables,
  jsonColumn,
  nullableTextColumn,
  scopedExecutorTable,
  type StorageDeps,
  type StorageFailure,
  textColumn,
} from "@executor-js/sdk/core";

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

export const googleDiscoverySchema = {
  google_discovery_source: scopedExecutorTable("google_discovery_source", {
    name: textColumn("name"),
    // Plugin-private structural config minus auth/credentials —
    // discoveryUrl, service, version, rootUrl, servicePath. These
    // never carry refs.
    config: jsonColumn("config"),
    auth_kind: textColumn("auth_kind").defaultTo("none"),
    auth_connection_id: nullableTextColumn("auth_connection_id"),
    auth_client_id_secret_id: nullableTextColumn("auth_client_id_secret_id"),
    auth_client_secret_secret_id: nullableTextColumn("auth_client_secret_secret_id"),
    // Stored as JSON because it is a string[] and carries no refs.
    auth_scopes: jsonColumn("auth_scopes").nullable(),
    created_at: dateColumn("created_at"),
    updated_at: dateColumn("updated_at"),
  }),
  google_discovery_source_credential_header: scopedExecutorTable(
    "google_discovery_source_credential_header",
    {
      source_id: textColumn("source_id"),
      name: textColumn("name"),
      kind: textColumn("kind"),
      text_value: nullableTextColumn("text_value"),
      secret_id: nullableTextColumn("secret_id"),
      secret_prefix: nullableTextColumn("secret_prefix"),
    },
  ),
  google_discovery_source_credential_query_param: scopedExecutorTable(
    "google_discovery_source_credential_query_param",
    {
      source_id: textColumn("source_id"),
      name: textColumn("name"),
      kind: textColumn("kind"),
      text_value: nullableTextColumn("text_value"),
      secret_id: nullableTextColumn("secret_id"),
      secret_prefix: nullableTextColumn("secret_prefix"),
    },
  ),
  google_discovery_binding: scopedExecutorTable("google_discovery_binding", {
    source_id: textColumn("source_id"),
    binding: jsonColumn("binding"),
    created_at: dateColumn("created_at"),
  }),
} satisfies FumaTables;

export type GoogleDiscoverySchema = typeof googleDiscoverySchema;

// ---------------------------------------------------------------------------
// Stored source projection for the extension API.
// ---------------------------------------------------------------------------

export interface GoogleDiscoveryStoredSource {
  readonly namespace: string;
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads choose scope explicitly in the FumaDB query. */
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
  readonly auth_connection_id: string | null;
  readonly auth_client_id_secret_id: string | null;
  readonly auth_client_secret_secret_id: string | null;
  readonly auth_scopes: string[];
}

const authToColumns = (auth: GoogleDiscoveryAuth): AuthColumns => {
  if (auth.kind === "oauth2") {
    return {
      auth_kind: "oauth2",
      auth_connection_id: auth.connectionId,
      auth_client_id_secret_id: auth.clientIdSecretId,
      auth_client_secret_secret_id: auth.clientSecretSecretId ?? null,
      auth_scopes: [...auth.scopes],
    };
  }
  return {
    auth_kind: "none",
    auth_connection_id: null,
    auth_client_id_secret_id: null,
    auth_client_secret_secret_id: null,
    auth_scopes: [],
  };
};

const columnsToAuth = (row: Record<string, unknown>): GoogleDiscoveryAuth => {
  if (
    row.auth_kind === "oauth2" &&
    typeof row.auth_connection_id === "string" &&
    typeof row.auth_client_id_secret_id === "string"
  ) {
    const csec = row.auth_client_secret_secret_id as string | null | undefined;
    const rawScopes = decodeJson(row.auth_scopes);
    const scopes = Array.isArray(rawScopes)
      ? rawScopes.filter((item): item is string => typeof item === "string")
      : [];
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

// Every read/write that targets a single keyed row pins BOTH the natural
// id (toolId, sourceId, sessionId) AND the owning `scope_id`. Scope is a
// normal FumaDB predicate here, not hidden behavior.
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
  const { fuma } = deps;

  return {
    getBinding: (toolId, scope) =>
      Effect.gen(function* () {
        const row = yield* fuma.use("google_discovery_binding.findFirstByScopedId", (db) =>
          db.findFirst("google_discovery_binding", {
            where: (b) => b.and(b("id", "=", toolId), b("scope_id", "=", scope)),
          }),
        );
        if (!row) return null;
        const decoded = decodeBinding(decodeJson(row.binding));
        return { namespace: decodeString(row.source_id), binding: decoded };
      }),

    putBinding: (toolId, sourceId, scope, binding) =>
      Effect.gen(function* () {
        yield* fuma.use("google_discovery_binding.deleteManyByScopedId", (db) =>
          db.deleteMany("google_discovery_binding", {
            where: (b) => b.and(b("id", "=", toolId), b("scope_id", "=", scope)),
          }),
        );
        yield* fuma.use("google_discovery_binding.create", (db) =>
          db.create("google_discovery_binding", {
            id: toolId,
            scope_id: scope,
            source_id: sourceId,
            binding: toJsonRecord(encodeBinding(binding)),
            created_at: new Date(),
          }),
        );
      }),

    removeBindingsBySource: (sourceId, scope) =>
      Effect.gen(function* () {
        const rows = yield* fuma.use("google_discovery_binding.findManyBySourceScope", (db) =>
          db.findMany("google_discovery_binding", {
            where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scope)),
          }),
        );
        const ids = rows.map((r) => decodeString(r.id));
        yield* fuma.use("google_discovery_binding.deleteManyBySourceScope", (db) =>
          db.deleteMany("google_discovery_binding", {
            where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scope)),
          }),
        );
        return ids;
      }),

    getBindingsForSource: (sourceId, scope) =>
      Effect.gen(function* () {
        const rows = yield* fuma.use("google_discovery_binding.findManyBySourceScope", (db) =>
          db.findMany("google_discovery_binding", {
            where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scope)),
          }),
        );
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
        yield* fuma.use("google_discovery_source.deleteManyByScopedId", (db) =>
          db.deleteMany("google_discovery_source", {
            where: (b) => b.and(b("id", "=", source.namespace), b("scope_id", "=", source.scope)),
          }),
        );
        yield* deleteSourceChildren(source.namespace, source.scope);

        const encoded = stripExtractedFields(
          decodeJsonObject(encodeStoredSourceData(source.config)),
        );
        yield* fuma.use("google_discovery_source.create", (db) =>
          db.create("google_discovery_source", {
            id: source.namespace,
            scope_id: source.scope,
            name: source.name,
            config: toJsonRecord(encoded),
            created_at: now,
            updated_at: now,
            ...authToColumns(source.config.auth),
          }),
        );
        yield* writeCredentialRows(source.namespace, source.scope, source.config.credentials);
      }),

    updateSourceMeta: (sourceId, scope, update) =>
      Effect.gen(function* () {
        const row = yield* fuma.use("google_discovery_source.findFirstByScopedId", (db) =>
          db.findFirst("google_discovery_source", {
            where: (b) => b.and(b("id", "=", sourceId), b("scope_id", "=", scope)),
          }),
        );
        if (!row) return;
        const auth = update.auth ?? columnsToAuth(row);
        yield* fuma.use("google_discovery_source.updateManyByScopedId", (db) =>
          db.updateMany("google_discovery_source", {
            where: (b) => b.and(b("id", "=", sourceId), b("scope_id", "=", scope)),
            set: {
              name: update.name ?? decodeString(row.name),
              updated_at: new Date(),
              ...authToColumns(auth),
            },
          }),
        );
      }),

    removeSource: (sourceId, scope) =>
      Effect.gen(function* () {
        yield* deleteSourceChildren(sourceId, scope);
        yield* fuma.use("google_discovery_source.deleteManyByScopedId", (db) =>
          db.deleteMany("google_discovery_source", {
            where: (b) => b.and(b("id", "=", sourceId), b("scope_id", "=", scope)),
          }),
        );
      }),

    getSource: (sourceId, scope) =>
      Effect.gen(function* () {
        const row = yield* fuma.use("google_discovery_source.findFirstByScopedId", (db) =>
          db.findFirst("google_discovery_source", {
            where: (b) => b.and(b("id", "=", sourceId), b("scope_id", "=", scope)),
          }),
        );
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
        const row = yield* fuma.use("google_discovery_source.findFirstByScopedId", (db) =>
          db.findFirst("google_discovery_source", {
            where: (b) => b.and(b("id", "=", sourceId), b("scope_id", "=", scope)),
          }),
        );
        if (!row) return null;
        return yield* hydrateStoredSourceData(row, sourceId, scope);
      }),

    findSourcesBySecret: (secretId) =>
      Effect.gen(function* () {
        const [byClientId, byClientSecret] = yield* Effect.all(
          [
            fuma.use("google_discovery_source.findManyByClientIdSecret", (db) =>
              db.findMany("google_discovery_source", {
                where: (b) => b("auth_client_id_secret_id", "=", secretId),
              }),
            ),
            fuma.use("google_discovery_source.findManyByClientSecretSecret", (db) =>
              db.findMany("google_discovery_source", {
                where: (b) => b("auth_client_secret_secret_id", "=", secretId),
              }),
            ),
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
      fuma
        .use("google_discovery_source.findManyByConnection", (db) =>
          db.findMany("google_discovery_source", {
            where: (b) => b("auth_connection_id", "=", connectionId),
          }),
        )
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
            fuma.use("google_discovery_source_credential_header.findManyBySecret", (db) =>
              db.findMany("google_discovery_source_credential_header", {
                where: (b) => b("secret_id", "=", secretId),
              }),
            ),
            fuma.use("google_discovery_source_credential_query_param.findManyBySecret", (db) =>
              db.findMany("google_discovery_source_credential_query_param", {
                where: (b) => b("secret_id", "=", secretId),
              }),
            ),
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
        const rows = yield* fuma.use("google_discovery_source.findMany", (db) =>
          db.findMany("google_discovery_source"),
        );
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
  // Closure helpers (depend on `fuma`).
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
        yield* fuma.use(`${model}.deleteManyBySourceScope`, (db) =>
          db.deleteMany(model, {
            where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scope)),
          }),
        );
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
        yield* fuma
          .use("google_discovery_source_credential_header.createMany", (db) =>
            db.createMany("google_discovery_source_credential_header", [...headerRows]),
          )
          .pipe(Effect.asVoid);
      }
      const paramRows = valueMapToRows(sourceId, scope, credentials.queryParams);
      if (paramRows.length > 0) {
        yield* fuma
          .use("google_discovery_source_credential_query_param.createMany", (db) =>
            db.createMany("google_discovery_source_credential_query_param", [...paramRows]),
          )
          .pipe(Effect.asVoid);
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
      const headerRows = yield* fuma.use(
        "google_discovery_source_credential_header.findManyBySourceScope",
        (db) =>
          db.findMany("google_discovery_source_credential_header", {
            where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scope)),
          }),
      );
      const paramRows = yield* fuma.use(
        "google_discovery_source_credential_query_param.findManyBySourceScope",
        (db) =>
          db.findMany("google_discovery_source_credential_query_param", {
            where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scope)),
          }),
      );
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

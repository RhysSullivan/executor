// ---------------------------------------------------------------------------
// OAuth legacy → Connection backfill (local)
// ---------------------------------------------------------------------------
//
// Runs at boot time right after `migrate()`. For every row still on the
// pre-refactor inline-OAuth shape (openapi_source, mcp_source,
// google_discovery_source), mints a Connection row, re-parents the
// referenced secret(s) to it, and rewrites the source's stored auth to
// the new pointer shape.
//
// Self-contained: the only plugin imports are current-shape parsing
// helpers. Each legacy shape is defined inline — this file is the last
// place in the codebase that still needs to know about them.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient } from "@effect/platform";
import {
  parse as parseOpenApi,
  resolveSpecText,
  OAuth2Auth,
} from "@executor/plugin-openapi";
import { McpConnectionAuth } from "@executor/plugin-mcp";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });

/** Pre-flight: bail unless the drizzle migration that added the Connection
 *  table + `secret.owned_by_connection_id` has completed. */
const connectionsReady = (sqlite: Database): boolean => {
  const secretColumns = sqlite
    .prepare("PRAGMA table_info('secret')")
    .all() as ReadonlyArray<{ readonly name: string }>;
  if (!secretColumns.some((c) => c.name === "owned_by_connection_id")) return false;
  const connectionTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connection'")
    .get();
  return connectionTable !== null && connectionTable !== undefined;
};

const tableExists = (sqlite: Database, name: string): boolean => {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== null && row !== undefined;
};

type SecretRow = { id: string; owned_by_connection_id: string | null };

/** Shared: re-parent the pointed-to secret ids to the new connection,
 *  backfilling any missing routing rows. Returns `null` on success, an
 *  error message string on skip. */
const rewireSecrets = (
  sqlite: Database,
  scopeId: string,
  connectionId: string,
  secretIds: ReadonlyArray<string>,
  namesByIndex: ReadonlyArray<string>,
): string | null => {
  const selectSecret = sqlite.prepare(
    "SELECT id, owned_by_connection_id FROM secret WHERE scope_id = ? AND id = ?",
  );
  const selectAnySecretProvider = sqlite.prepare(
    "SELECT provider FROM secret WHERE scope_id = ? LIMIT 1",
  );
  const updateSecretOwner = sqlite.prepare(
    "UPDATE secret SET owned_by_connection_id = ? WHERE scope_id = ? AND id = ?",
  );
  const insertSecret = sqlite.prepare(
    `INSERT INTO secret (
       id, scope_id, provider, name,
       owned_by_connection_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const rows = secretIds.map(
    (sid) => selectSecret.get(scopeId, sid) as SecretRow | undefined,
  );
  const alreadyOwned = rows
    .filter((r): r is SecretRow => !!r)
    .filter(
      (r) =>
        r.owned_by_connection_id !== null &&
        r.owned_by_connection_id !== connectionId,
    );
  if (alreadyOwned.length > 0) return "secret(s) already owned";

  // Early-onboarded rows never got a `secret` routing row — pre-refactor
  // `secretsGet` resolved them via provider enumeration. Pick the
  // provider already in use at this scope (or fall back to keychain) so
  // the new id-indexed fast path resolves. If we guess wrong the SDK's
  // enumerate-fallback still works.
  const missingCount = rows.filter((r) => r === undefined).length;
  let fallbackProvider: string | null = null;
  if (missingCount > 0) {
    const existing = selectAnySecretProvider.get(scopeId) as
      | { provider: string }
      | undefined;
    fallbackProvider = existing?.provider ?? "keychain";
  }

  const now = Date.now();
  for (let i = 0; i < secretIds.length; i++) {
    const sid = secretIds[i]!;
    if (rows[i] === undefined) {
      insertSecret.run(sid, scopeId, fallbackProvider!, namesByIndex[i]!, connectionId, now);
    } else {
      updateSecretOwner.run(connectionId, scopeId, sid);
    }
  }
  return null;
};

const insertConnectionRow = (
  sqlite: Database,
  params: {
    id: string;
    scopeId: string;
    provider: string;
    identityLabel: string;
    accessTokenSecretId: string;
    refreshTokenSecretId: string | null;
    expiresAt: number | null;
    scope: string | null;
    providerState: unknown;
  },
): void => {
  const stmt = sqlite.prepare(
    `INSERT INTO connection (
       id, scope_id, provider, kind, identity_label,
       access_token_secret_id, refresh_token_secret_id,
       expires_at, scope, provider_state,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  stmt.run(
    params.id,
    params.scopeId,
    params.provider,
    "user",
    params.identityLabel,
    params.accessTokenSecretId,
    params.refreshTokenSecretId,
    params.expiresAt,
    params.scope,
    JSON.stringify(params.providerState),
    now,
    now,
  );
};

// ---------------------------------------------------------------------------
// OpenAPI — legacy shape
// ---------------------------------------------------------------------------

const OAuth2Flow = Schema.Literal("authorizationCode", "clientCredentials");

class LegacyOpenApiOAuth2 extends Schema.Class<LegacyOpenApiOAuth2>("LegacyOpenApiOAuth2")({
  kind: Schema.Literal("oauth2"),
  securitySchemeName: Schema.String,
  flow: OAuth2Flow,
  tokenUrl: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.NullOr(Schema.String),
  tokenType: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
}) {}

const decodeOpenApiCurrent = Schema.decodeUnknownOption(OAuth2Auth);
const decodeOpenApiLegacy = Schema.decodeUnknownOption(LegacyOpenApiOAuth2);

const extractAuthorizationUrl = async (
  rawSpec: string,
  securitySchemeName: string,
  flow: "authorizationCode" | "clientCredentials",
): Promise<string | null> => {
  if (flow === "clientCredentials") return null;
  const parsed = await Effect.runPromise(
    resolveSpecText(rawSpec).pipe(
      Effect.flatMap((text) => parseOpenApi(text)),
      Effect.provide(FetchHttpClient.layer),
      Effect.either,
    ),
  );
  if (parsed._tag === "Left") return null;
  const spec = parsed.right as unknown;
  if (!isRecord(spec)) return null;
  const components = isRecord(spec.components) ? spec.components : null;
  const schemes = components && isRecord(components.securitySchemes)
    ? components.securitySchemes
    : null;
  const scheme = schemes && isRecord(schemes[securitySchemeName])
    ? (schemes[securitySchemeName] as Record<string, unknown>)
    : null;
  const flows = scheme && isRecord(scheme.flows) ? scheme.flows : null;
  const flowObj = flows && isRecord(flows.authorizationCode)
    ? (flows.authorizationCode as Record<string, unknown>)
    : null;
  return flowObj && isString(flowObj.authorizationUrl)
    ? flowObj.authorizationUrl
    : null;
};

type OpenApiRow = {
  scope_id: string;
  id: string;
  name: string;
  spec: string;
  invocation_config: string | null;
  oauth2: string | null;
};

const migrateOpenApi = async (sqlite: Database): Promise<void> => {
  if (!tableExists(sqlite, "openapi_source")) return;
  const rows = sqlite
    .prepare(
      "SELECT scope_id, id, name, spec, invocation_config, oauth2 FROM openapi_source",
    )
    .all() as ReadonlyArray<OpenApiRow>;
  if (rows.length === 0) return;

  const updateSource = sqlite.prepare(
    "UPDATE openapi_source SET oauth2 = ?, invocation_config = ? WHERE scope_id = ? AND id = ?",
  );

  for (const row of rows) {
    let invocation: Record<string, unknown> = {};
    if (row.invocation_config) {
      try {
        const parsed = JSON.parse(row.invocation_config) as unknown;
        if (isRecord(parsed)) invocation = parsed;
      } catch {
        continue;
      }
    }
    let oauth2Col: unknown = null;
    if (row.oauth2) {
      try {
        oauth2Col = JSON.parse(row.oauth2) as unknown;
      } catch {
        // fall through
      }
    }
    const primary = invocation.oauth2 ?? oauth2Col;
    if (primary == null) continue;
    if (Option.isSome(decodeOpenApiCurrent(primary))) continue;

    const legacyOption = decodeOpenApiLegacy(primary);
    if (Option.isNone(legacyOption)) continue;
    const legacy = legacyOption.value;

    const authorizationUrl = await extractAuthorizationUrl(
      row.spec,
      legacy.securitySchemeName,
      legacy.flow,
    );
    if (legacy.flow === "authorizationCode" && authorizationUrl === null) {
      console.warn(
        `[migrate-connections] skip openapi ${row.scope_id}/${row.id}: authorizationCode flow but authorizationUrl unavailable`,
      );
      continue;
    }

    const connectionId = `openapi-oauth2-${randomUUID()}`;
    const providerState = {
      flow: legacy.flow,
      tokenUrl: legacy.tokenUrl,
      clientIdSecretId: legacy.clientIdSecretId,
      clientSecretSecretId: legacy.clientSecretSecretId,
      scopes: legacy.scopes,
    };
    const oauth2Pointer = {
      kind: "oauth2" as const,
      connectionId,
      securitySchemeName: legacy.securitySchemeName,
      flow: legacy.flow,
      tokenUrl: legacy.tokenUrl,
      authorizationUrl,
      clientIdSecretId: legacy.clientIdSecretId,
      clientSecretSecretId: legacy.clientSecretSecretId,
      scopes: legacy.scopes,
    };

    const secretIds = [legacy.accessTokenSecretId];
    const secretNames = [`Connection ${connectionId} access token`];
    if (legacy.refreshTokenSecretId) {
      secretIds.push(legacy.refreshTokenSecretId);
      secretNames.push(`Connection ${connectionId} refresh token`);
    }

    const txn = sqlite.transaction(() => {
      insertConnectionRow(sqlite, {
        id: connectionId,
        scopeId: row.scope_id,
        provider: "openapi:oauth2",
        identityLabel: row.name,
        accessTokenSecretId: legacy.accessTokenSecretId,
        refreshTokenSecretId: legacy.refreshTokenSecretId,
        expiresAt: legacy.expiresAt,
        scope: legacy.scope,
        providerState,
      });
      const err = rewireSecrets(sqlite, row.scope_id, connectionId, secretIds, secretNames);
      if (err) throw new Error(err);
      const nextInvocation = { ...invocation, oauth2: oauth2Pointer };
      updateSource.run(
        JSON.stringify(oauth2Pointer),
        JSON.stringify(nextInvocation),
        row.scope_id,
        row.id,
      );
    });
    try {
      txn();
      console.log(
        `[migrate-connections] openapi ${row.scope_id}/${row.id} -> ${connectionId}`,
      );
    } catch (err) {
      console.warn(
        `[migrate-connections] fail openapi ${row.scope_id}/${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// MCP — legacy shape
// ---------------------------------------------------------------------------

const LegacyMcpOAuth2 = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.NullOr(Schema.String),
  tokenType: Schema.optionalWith(Schema.String, { default: () => "Bearer" }),
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
  clientInformation: Schema.optionalWith(Schema.NullOr(JsonObject), {
    default: () => null,
  }),
  authorizationServerUrl: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
  resourceMetadataUrl: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
});

const decodeMcpCurrent = Schema.decodeUnknownOption(McpConnectionAuth);
const decodeMcpLegacy = Schema.decodeUnknownOption(LegacyMcpOAuth2);

type McpRow = {
  scope_id: string;
  id: string;
  name: string;
  config: string;
};

const migrateMcp = (sqlite: Database): void => {
  if (!tableExists(sqlite, "mcp_source")) return;
  const rows = sqlite
    .prepare("SELECT scope_id, id, name, config FROM mcp_source")
    .all() as ReadonlyArray<McpRow>;
  if (rows.length === 0) return;

  const updateSource = sqlite.prepare(
    "UPDATE mcp_source SET config = ? WHERE scope_id = ? AND id = ?",
  );

  for (const row of rows) {
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.config) as unknown;
      if (!isRecord(parsed)) continue;
      config = parsed;
    } catch {
      continue;
    }
    if (config.transport !== "remote") continue;
    const auth = config.auth;
    if (!isRecord(auth) || auth.kind !== "oauth2") continue;

    if (Option.isSome(decodeMcpCurrent(auth))) continue;

    const legacyOption = decodeMcpLegacy(auth);
    if (Option.isNone(legacyOption)) continue;
    const legacy = legacyOption.value;

    const endpoint = typeof config.endpoint === "string" ? config.endpoint : null;
    if (!endpoint) {
      console.warn(
        `[migrate-connections] skip mcp ${row.scope_id}/${row.id}: endpoint missing`,
      );
      continue;
    }
    const connectionId = `mcp-oauth2-${row.id}`;
    const providerState = {
      endpoint,
      tokenType: legacy.tokenType,
      clientInformation: legacy.clientInformation,
      authorizationServerUrl: legacy.authorizationServerUrl,
      authorizationServerMetadata: null,
      resourceMetadataUrl: legacy.resourceMetadataUrl,
      resourceMetadata: null,
    };
    const authPointer = { kind: "oauth2" as const, connectionId };
    const nextConfig = { ...config, auth: authPointer };

    const secretIds = [legacy.accessTokenSecretId];
    const secretNames = [`Connection ${connectionId} access token`];
    if (legacy.refreshTokenSecretId) {
      secretIds.push(legacy.refreshTokenSecretId);
      secretNames.push(`Connection ${connectionId} refresh token`);
    }

    const txn = sqlite.transaction(() => {
      insertConnectionRow(sqlite, {
        id: connectionId,
        scopeId: row.scope_id,
        provider: "mcp:oauth2",
        identityLabel: row.name,
        accessTokenSecretId: legacy.accessTokenSecretId,
        refreshTokenSecretId: legacy.refreshTokenSecretId,
        expiresAt: legacy.expiresAt,
        scope: legacy.scope,
        providerState,
      });
      const err = rewireSecrets(sqlite, row.scope_id, connectionId, secretIds, secretNames);
      if (err) throw new Error(err);
      updateSource.run(JSON.stringify(nextConfig), row.scope_id, row.id);
    });
    try {
      txn();
      console.log(
        `[migrate-connections] mcp ${row.scope_id}/${row.id} -> ${connectionId}`,
      );
    } catch (err) {
      console.warn(
        `[migrate-connections] fail mcp ${row.scope_id}/${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// google-discovery — legacy shape
// ---------------------------------------------------------------------------

const LegacyGoogleDiscoveryOAuth2 = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.NullOr(Schema.String),
  tokenType: Schema.optionalWith(Schema.String, { default: () => "Bearer" }),
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
});

const CurrentGoogleDiscoveryOAuth2 = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  connectionId: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
});

const decodeGoogleCurrent = Schema.decodeUnknownOption(CurrentGoogleDiscoveryOAuth2);
const decodeGoogleLegacy = Schema.decodeUnknownOption(LegacyGoogleDiscoveryOAuth2);

type GoogleRow = {
  scope_id: string;
  id: string;
  name: string;
  config: string;
};

const migrateGoogleDiscovery = (sqlite: Database): void => {
  if (!tableExists(sqlite, "google_discovery_source")) return;
  const rows = sqlite
    .prepare("SELECT scope_id, id, name, config FROM google_discovery_source")
    .all() as ReadonlyArray<GoogleRow>;
  if (rows.length === 0) return;

  const updateSource = sqlite.prepare(
    "UPDATE google_discovery_source SET config = ?, updated_at = ? WHERE scope_id = ? AND id = ?",
  );

  for (const row of rows) {
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.config) as unknown;
      if (!isRecord(parsed)) continue;
      config = parsed;
    } catch {
      continue;
    }
    const auth = config.auth;
    if (!isRecord(auth) || auth.kind !== "oauth2") continue;

    if (Option.isSome(decodeGoogleCurrent(auth))) continue;

    const legacyOption = decodeGoogleLegacy(auth);
    if (Option.isNone(legacyOption)) continue;
    const legacy = legacyOption.value;

    const connectionId = `google-discovery-oauth2-${randomUUID()}`;
    const providerState = {
      clientIdSecretId: legacy.clientIdSecretId,
      clientSecretSecretId: legacy.clientSecretSecretId,
      scopes: legacy.scopes,
    };
    const authPointer = {
      kind: "oauth2" as const,
      connectionId,
      clientIdSecretId: legacy.clientIdSecretId,
      clientSecretSecretId: legacy.clientSecretSecretId,
      scopes: legacy.scopes,
    };
    const nextConfig = { ...config, auth: authPointer };

    const secretIds = [legacy.accessTokenSecretId];
    const secretNames = [`Connection ${connectionId} access token`];
    if (legacy.refreshTokenSecretId) {
      secretIds.push(legacy.refreshTokenSecretId);
      secretNames.push(`Connection ${connectionId} refresh token`);
    }

    const txn = sqlite.transaction(() => {
      insertConnectionRow(sqlite, {
        id: connectionId,
        scopeId: row.scope_id,
        provider: "google-discovery:oauth2",
        identityLabel: row.name,
        accessTokenSecretId: legacy.accessTokenSecretId,
        refreshTokenSecretId: legacy.refreshTokenSecretId,
        expiresAt: legacy.expiresAt,
        scope: legacy.scope,
        providerState,
      });
      const err = rewireSecrets(sqlite, row.scope_id, connectionId, secretIds, secretNames);
      if (err) throw new Error(err);
      updateSource.run(JSON.stringify(nextConfig), Date.now(), row.scope_id, row.id);
    });
    try {
      txn();
      console.log(
        `[migrate-connections] google-discovery ${row.scope_id}/${row.id} -> ${connectionId}`,
      );
    } catch (err) {
      console.warn(
        `[migrate-connections] fail google-discovery ${row.scope_id}/${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// Umbrella
// ---------------------------------------------------------------------------

/**
 * Scan openapi_source, mcp_source, and google_discovery_source; migrate
 * any row still on its plugin's legacy inline-OAuth shape to a fresh
 * Connection row + pointer. Idempotent — rows already on the current
 * shape are skipped. Logs one line per migrated row.
 */
export const migrateLegacyConnections = async (sqlite: Database): Promise<void> => {
  if (!connectionsReady(sqlite)) return;
  await migrateOpenApi(sqlite);
  migrateMcp(sqlite);
  migrateGoogleDiscovery(sqlite);
};

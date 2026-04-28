// ---------------------------------------------------------------------------
// OpenAPI OAuth legacy → Connection backfill (cloud)
// ---------------------------------------------------------------------------
//
// Dry-run by default. `--apply` runs the per-row transactions:
//   1. INSERT connection row with provider_state pulled from the legacy row.
//   2. UPDATE secret.owned_by_connection_id for the 1–2 referenced secrets.
//   3. UPDATE openapi_source (oauth2 + invocation_config.oauth2) to the
//      new pointer shape.
//
// Self-contained: the only plugin imports are parser helpers for the
// current shape. The pre-refactor OAuth2 shape is defined here — this
// script is the last place it's needed, and it ships with the migration.
//
// Run (dry-run):
//   op run --env-file=.env.production -- bun run scripts/migrate-connections.ts
// Run (apply):
//   op run --env-file=.env.production -- bun run scripts/migrate-connections.ts --apply

import { randomUUID } from "node:crypto";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient } from "@effect/platform";
import postgres from "postgres";

import {
  parse as parseOpenApi,
  resolveSpecText,
  OAuth2Auth,
} from "@executor/plugin-openapi";

const APPLY = process.argv.includes("--apply");

// ---------------------------------------------------------------------------
// Legacy OAuth2 shape (pre-refactor). Inlined on purpose: this is the only
// place in the codebase that still needs to know about it. Once cloud +
// local have run this migration, this script can be deleted.
// ---------------------------------------------------------------------------

const OAuth2Flow = Schema.Literal("authorizationCode", "clientCredentials");

class LegacyOAuth2Auth extends Schema.Class<LegacyOAuth2Auth>("LegacyOAuth2Auth")({
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

const decodeCurrent = Schema.decodeUnknownOption(OAuth2Auth);
const decodeLegacy = Schema.decodeUnknownOption(LegacyOAuth2Auth);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

// ---------------------------------------------------------------------------
// Spec → authorizationUrl extraction (for authorizationCode flow only).
// Uses the plugin's real parser so JSON/YAML + URL-fetch fallback match
// runtime behavior exactly.
// ---------------------------------------------------------------------------

const extractAuthorizationUrl = async (
  rawSpec: string,
  securitySchemeName: string,
  flow: "authorizationCode" | "clientCredentials",
): Promise<{ url: string | null; note: string }> => {
  if (flow === "clientCredentials") {
    return { url: null, note: "clientCredentials — no authorizationUrl needed" };
  }
  const parsed = await Effect.runPromise(
    resolveSpecText(rawSpec).pipe(
      Effect.flatMap((text) => parseOpenApi(text)),
      Effect.provide(FetchHttpClient.layer),
      Effect.either,
    ),
  );
  if (parsed._tag === "Left") {
    return { url: null, note: `spec parse failed: ${parsed.left.message}` };
  }
  const spec = parsed.right as unknown;
  if (!isRecord(spec)) return { url: null, note: "spec is not an object" };
  const components = isRecord(spec.components) ? spec.components : null;
  if (!components) return { url: null, note: "spec.components missing" };
  const schemes = isRecord(components.securitySchemes)
    ? components.securitySchemes
    : null;
  if (!schemes) return { url: null, note: "spec.components.securitySchemes missing" };
  const scheme = schemes[securitySchemeName];
  if (!isRecord(scheme)) {
    return { url: null, note: `securitySchemes[${securitySchemeName}] missing` };
  }
  const flows = isRecord(scheme.flows) ? scheme.flows : null;
  if (!flows) return { url: null, note: "scheme.flows missing" };
  const flowObj = isRecord(flows.authorizationCode) ? flows.authorizationCode : null;
  if (!flowObj) return { url: null, note: "flows.authorizationCode missing" };
  if (!isString(flowObj.authorizationUrl)) {
    return { url: null, note: "authorizationUrl missing on flow" };
  }
  return { url: flowObj.authorizationUrl, note: "extracted from spec" };
};

// ---------------------------------------------------------------------------
// Row classification
// ---------------------------------------------------------------------------

type Row = {
  scope_id: string;
  id: string;
  name: string;
  spec: string;
  invocation_config: unknown;
  oauth2_col: unknown;
};

type Bucket =
  | { kind: "no-oauth"; row: Row }
  | { kind: "current"; row: Row }
  | {
      kind: "legacy-migratable";
      row: Row;
      legacy: LegacyOAuth2Auth;
      authorizationUrl: string | null;
      authorizationUrlNote: string;
    }
  | { kind: "legacy-blocked"; row: Row; legacy: LegacyOAuth2Auth; reason: string }
  | { kind: "unknown"; row: Row; rawOAuth2: unknown; shape: string };

const classifyRow = async (row: Row): Promise<Bucket> => {
  const invocation = isRecord(row.invocation_config) ? row.invocation_config : {};
  const primary = invocation.oauth2 ?? row.oauth2_col;
  if (primary == null) return { kind: "no-oauth", row };

  if (Option.isSome(decodeCurrent(primary))) return { kind: "current", row };

  const legacyOption = decodeLegacy(primary);
  if (Option.isSome(legacyOption)) {
    const legacy = legacyOption.value;
    const { url, note } = await extractAuthorizationUrl(
      row.spec,
      legacy.securitySchemeName,
      legacy.flow,
    );
    if (legacy.flow === "authorizationCode" && url === null) {
      return {
        kind: "legacy-blocked",
        row,
        legacy,
        reason: `authorizationCode flow but ${note}`,
      };
    }
    return {
      kind: "legacy-migratable",
      row,
      legacy,
      authorizationUrl: url,
      authorizationUrlNote: note,
    };
  }

  const shape = isRecord(primary)
    ? `{${Object.keys(primary).sort().join(",")}}`
    : typeof primary;
  return { kind: "unknown", row, rawOAuth2: primary, shape };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type SecretRow = {
  id: string;
  scope_id: string;
  owned_by_connection_id: string | null;
};

const main = async () => {
  const connectionString =
    process.env.DATABASE_URL || process.env.HYPERDRIVE_CONNECTION_STRING || "";
  if (!connectionString) {
    console.error(
      "DATABASE_URL not set (try: op run --env-file=.env.production -- ...)",
    );
    process.exit(1);
  }

  const sql = postgres(connectionString, {
    max: 1,
    onnotice: () => undefined,
    ssl: "require",
  });

  try {
    const rows = (await sql<Row[]>`
      select
        scope_id,
        id,
        name,
        spec,
        invocation_config,
        oauth2 as oauth2_col
      from openapi_source
    `) as Row[];

    console.log(`\nScanned ${rows.length} openapi_source row(s)`);
    console.log(APPLY ? "Mode: APPLY (writes enabled)\n" : "Mode: DRY-RUN (no writes)\n");

    const buckets = await Promise.all(rows.map(classifyRow));

    const counts = {
      "no-oauth": 0,
      current: 0,
      "legacy-migratable": 0,
      "legacy-blocked": 0,
      unknown: 0,
    };
    for (const b of buckets) counts[b.kind]++;

    console.log("Classification:");
    console.log(`  no oauth2 config:          ${counts["no-oauth"]}`);
    console.log(`  already on new shape:      ${counts.current}`);
    console.log(`  legacy — would migrate:    ${counts["legacy-migratable"]}`);
    console.log(`  legacy — blocked:          ${counts["legacy-blocked"]}`);
    console.log(`  unrecognized shape:        ${counts.unknown}\n`);

    const migratable = buckets.filter(
      (b): b is Extract<Bucket, { kind: "legacy-migratable" }> =>
        b.kind === "legacy-migratable",
    );
    const blocked = buckets.filter(
      (b) => b.kind === "legacy-blocked" || b.kind === "unknown",
    );

    for (const b of blocked) {
      const ref = `${b.row.scope_id}/${b.row.id}`;
      if (b.kind === "legacy-blocked") {
        console.log(`[BLOCKED] ${ref}`);
        console.log(`  reason: ${b.reason}`);
        console.log(`  spec length: ${b.row.spec.length}`);
      } else if (b.kind === "unknown") {
        console.log(`[UNKNOWN] ${ref}`);
        console.log(`  shape: ${b.shape}`);
      }
      console.log();
    }

    for (const b of migratable) {
      const ref = `${b.row.scope_id}/${b.row.id}`;
      console.log(`[migratable] ${ref}`);
      console.log(`  flow:             ${b.legacy.flow}`);
      console.log(`  scheme:           ${b.legacy.securitySchemeName}`);
      console.log(
        `  authorizationUrl: ${b.authorizationUrl ?? "(null)"} — ${b.authorizationUrlNote}`,
      );
      console.log();
    }

    if (blocked.length > 0) {
      console.log(
        `ABORT: ${blocked.length} row(s) blocked or unrecognized; inspect above and fix or delete before re-running.`,
      );
      process.exit(2);
    }

    if (!APPLY) {
      console.log(`OK: ${migratable.length} row(s) would migrate. Re-run with --apply.`);
      return;
    }

    if (migratable.length === 0) {
      console.log("Nothing to migrate.");
      return;
    }

    let applied = 0;
    let failed = 0;
    for (const b of migratable) {
      const ref = `${b.row.scope_id}/${b.row.id}`;
      const connectionId = `openapi-oauth2-${randomUUID()}`;
      const l = b.legacy;
      const providerState = {
        flow: l.flow,
        tokenUrl: l.tokenUrl,
        clientIdSecretId: l.clientIdSecretId,
        clientSecretSecretId: l.clientSecretSecretId,
        scopes: l.scopes,
      };
      const oauth2Pointer = {
        kind: "oauth2" as const,
        connectionId,
        securitySchemeName: l.securitySchemeName,
        flow: l.flow,
        tokenUrl: l.tokenUrl,
        authorizationUrl: b.authorizationUrl,
        clientIdSecretId: l.clientIdSecretId,
        clientSecretSecretId: l.clientSecretSecretId,
        scopes: l.scopes,
      };

      try {
        await sql.begin(async (tx) => {
          await tx`
            insert into connection (
              id, scope_id, provider, kind, identity_label,
              access_token_secret_id, refresh_token_secret_id,
              expires_at, scope, provider_state,
              created_at, updated_at
            ) values (
              ${connectionId},
              ${b.row.scope_id},
              ${"openapi:oauth2"},
              ${"user"},
              ${b.row.name},
              ${l.accessTokenSecretId},
              ${l.refreshTokenSecretId},
              ${l.expiresAt},
              ${l.scope},
              ${tx.json(providerState)},
              now(),
              now()
            )
          `;

          const secretIds = [l.accessTokenSecretId];
          if (l.refreshTokenSecretId) secretIds.push(l.refreshTokenSecretId);

          const existing = (await tx<SecretRow[]>`
            select id, scope_id, owned_by_connection_id
            from secret
            where scope_id = ${b.row.scope_id} and id = any(${secretIds})
          `) as SecretRow[];
          const alreadyOwned = existing.filter(
            (r) =>
              r.owned_by_connection_id !== null &&
              r.owned_by_connection_id !== connectionId,
          );
          if (alreadyOwned.length > 0) {
            throw new Error(
              `secret(s) already owned: ${alreadyOwned.map((r) => `${r.id}(owner=${r.owned_by_connection_id})`).join(", ")}`,
            );
          }
          // Some early-onboarded OpenAPI OAuth tokens never got a `secret`
          // routing row — the pre-refactor `secretsGet` fallback resolved
          // them via provider enumeration. Backfill the missing rows
          // pointing at `workos-vault` (the only writable provider on
          // cloud) so the new SDK's id-indexed fast path finds them.
          const missing = secretIds.filter(
            (id) => !existing.some((r) => r.id === id),
          );
          for (const id of missing) {
            const name =
              id === l.accessTokenSecretId
                ? `Connection ${connectionId} access token`
                : `Connection ${connectionId} refresh token`;
            await tx`
              insert into secret (
                id, scope_id, provider, name,
                owned_by_connection_id, created_at
              ) values (
                ${id}, ${b.row.scope_id}, ${"workos-vault"}, ${name},
                ${connectionId}, now()
              )
            `;
          }
          if (existing.length > 0) {
            await tx`
              update secret
              set owned_by_connection_id = ${connectionId}
              where scope_id = ${b.row.scope_id} and id = any(${secretIds})
            `;
          }

          const nextInvocation = {
            ...(isRecord(b.row.invocation_config) ? b.row.invocation_config : {}),
            oauth2: oauth2Pointer,
          };

          await tx`
            update openapi_source
            set
              oauth2 = ${tx.json(oauth2Pointer)},
              invocation_config = ${tx.json(nextInvocation)}
            where scope_id = ${b.row.scope_id} and id = ${b.row.id}
          `;
        });
        applied++;
        console.log(`  [OK]   ${ref} -> ${connectionId}`);
      } catch (err) {
        failed++;
        console.log(
          `  [FAIL] ${ref}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log();
    console.log(`Applied: ${applied}`);
    console.log(`Failed:  ${failed}`);
    if (failed > 0) process.exit(3);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

main().catch((err) => {
  console.error("migrate-connections failed:", err);
  process.exit(1);
});

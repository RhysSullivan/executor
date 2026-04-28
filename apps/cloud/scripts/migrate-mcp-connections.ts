// ---------------------------------------------------------------------------
// MCP OAuth legacy → Connection backfill (cloud)
// ---------------------------------------------------------------------------
//
// Companion to migrate-connections.ts (which handled OpenAPI). Same shape,
// different table: scans `mcp_source`, finds rows whose `config.auth` is
// still on the pre-refactor inline-OAuth shape, mints a stable per-source
// Connection row, backfills the secret routing rows, and rewrites
// `config.auth` to the `{kind:"oauth2", connectionId}` pointer.
//
// Dry-run by default. `--apply` runs the per-row transactions.
//
// Run (dry-run):
//   op run --env-file=.env.production -- bun run scripts/migrate-mcp-connections.ts
// Run (apply):
//   op run --env-file=.env.production -- bun run scripts/migrate-mcp-connections.ts --apply

import { Option, Schema } from "effect";
import postgres from "postgres";

import { McpConnectionAuth } from "@executor/plugin-mcp";

const APPLY = process.argv.includes("--apply");
const DUMP_BLOCKED = process.argv.includes("--dump-blocked");

// ---------------------------------------------------------------------------
// Legacy MCP oauth2 auth shape (pre-refactor). Inlined — this script is the
// only place that still needs to know about it. Once cloud + local have
// run this migration, the file can be deleted.
// ---------------------------------------------------------------------------

const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });

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
type LegacyMcpOAuth2 = typeof LegacyMcpOAuth2.Type;

const decodeCurrentAuth = Schema.decodeUnknownOption(McpConnectionAuth);
const decodeLegacy = Schema.decodeUnknownOption(LegacyMcpOAuth2);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Row classification
// ---------------------------------------------------------------------------

type Row = {
  scope_id: string;
  id: string;
  name: string;
  config: unknown;
};

type Bucket =
  | { kind: "non-remote"; row: Row }
  | { kind: "no-oauth"; row: Row }
  | { kind: "current"; row: Row }
  | { kind: "legacy-migratable"; row: Row; legacy: LegacyMcpOAuth2; endpoint: string }
  | { kind: "legacy-blocked"; row: Row; legacy: LegacyMcpOAuth2; reason: string }
  | { kind: "unknown"; row: Row; shape: string };

const classifyRow = (row: Row): Bucket => {
  if (!isRecord(row.config)) return { kind: "unknown", row, shape: typeof row.config };
  if (row.config.transport !== "remote") return { kind: "non-remote", row };
  const auth = row.config.auth;
  if (!isRecord(auth)) return { kind: "no-oauth", row };
  if (auth.kind !== "oauth2") return { kind: "no-oauth", row };

  if (Option.isSome(decodeCurrentAuth(auth))) return { kind: "current", row };

  const legacyOption = decodeLegacy(auth);
  if (Option.isSome(legacyOption)) {
    const legacy = legacyOption.value;
    const endpoint =
      typeof row.config.endpoint === "string" ? row.config.endpoint : null;
    if (!endpoint) {
      return {
        kind: "legacy-blocked",
        row,
        legacy,
        reason: "config.endpoint missing",
      };
    }
    return { kind: "legacy-migratable", row, legacy, endpoint };
  }

  const shape = `{${Object.keys(auth).sort().join(",")}}`;
  return { kind: "unknown", row, shape };
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
      select scope_id, id, name, config
      from mcp_source
    `) as Row[];

    console.log(`\nScanned ${rows.length} mcp_source row(s)`);
    console.log(APPLY ? "Mode: APPLY (writes enabled)\n" : "Mode: DRY-RUN (no writes)\n");

    const buckets = rows.map(classifyRow);

    const counts = {
      "non-remote": 0,
      "no-oauth": 0,
      current: 0,
      "legacy-migratable": 0,
      "legacy-blocked": 0,
      unknown: 0,
    };
    for (const b of buckets) counts[b.kind]++;

    console.log("Classification:");
    console.log(`  non-remote (stdio):        ${counts["non-remote"]}`);
    console.log(`  no oauth2 auth:            ${counts["no-oauth"]}`);
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
      } else if (b.kind === "unknown") {
        console.log(`[UNKNOWN] ${ref}`);
        console.log(`  shape: ${b.shape}`);
      }
      if (DUMP_BLOCKED && isRecord(b.row.config)) {
        console.log(`  auth: ${JSON.stringify(b.row.config.auth, null, 2)}`);
      }
      console.log();
    }

    for (const b of migratable) {
      const ref = `${b.row.scope_id}/${b.row.id}`;
      console.log(`[migratable] ${ref}`);
      console.log(`  endpoint:           ${b.endpoint}`);
      console.log(`  accessTokenSecret:  ${b.legacy.accessTokenSecretId}`);
      console.log(
        `  refreshTokenSecret: ${b.legacy.refreshTokenSecretId ?? "(null)"}`,
      );
      console.log(
        `  authServerUrl:      ${b.legacy.authorizationServerUrl ?? "(null)"}`,
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
      const connectionId = `mcp-oauth2-${b.row.id}`;
      const l = b.legacy;
      const providerState = {
        endpoint: b.endpoint,
        tokenType: l.tokenType,
        clientInformation: l.clientInformation,
        authorizationServerUrl: l.authorizationServerUrl,
        authorizationServerMetadata: null,
        resourceMetadataUrl: l.resourceMetadataUrl,
        resourceMetadata: null,
      };
      const authPointer = { kind: "oauth2" as const, connectionId };
      const nextConfig = { ...(isRecord(b.row.config) ? b.row.config : {}), auth: authPointer };

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
              ${"mcp:oauth2"},
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
          // Backfill any missing routing rows pointing at workos-vault, the
          // only writable provider on cloud. Matches the openapi migration.
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

          await tx`
            update mcp_source
            set config = ${tx.json(nextConfig)}
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
  console.error("migrate-mcp-connections failed:", err);
  process.exit(1);
});

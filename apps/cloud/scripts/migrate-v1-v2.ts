/**
 * v1 → v2 cloud migration runner (operator-run, out-of-band).
 *
 * DRY-RUN by default: reads the v1 tables read-only, builds the full v2 plan via
 * the pure `planMigration` weave, and prints the §8 report. NOTHING is written.
 *
 *   op run --env-file=.env.production -- bun apps/cloud/scripts/migrate-v1-v2.ts
 *
 * `--apply` (guarded; NOT for prod without a clone + live WorkOS creds) would run
 * the structural SQL + the WorkOS-Vault re-key value pass. That path is scaffolded
 * but intentionally throws until wired to a vault client + reviewed — see APPLY.
 *
 * Idempotency: every `SecretOp.itemId` is deterministic, the structural writes use
 * ON CONFLICT, so a crashed run re-runs clean.
 */
import postgres from "postgres";

import {
  planMigration,
  migrateOpenApiSourceConfig,
  migrateMcpSourceConfig,
  migrateGraphqlSourceConfig,
  migrationSourceKey,
  type MigratedSourceConfig,
  type MigrationInput,
  type V1SourceRow,
} from "@executor-js/sdk/migration";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set (run via `op run --env-file=.env.production --`).");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const DATABASE_SSL = process.env.DATABASE_SSL?.trim().toLowerCase();
const ssl =
  DATABASE_SSL === "disable" || DATABASE_SSL === "false" || DATABASE_SSL === "0"
    ? false
    : "require";

const sql = postgres(DATABASE_URL, { max: 1, prepare: false, ssl });

interface Row {
  readonly [k: string]: unknown;
}

const buildConfig = (kind: string, data: Record<string, unknown>): MigratedSourceConfig => {
  // openapi + mcp nest the per-kind config under `.config`; graphql is flat.
  const cfg = (data.config as Record<string, unknown> | undefined) ?? data;
  if (kind === "mcp") return migrateMcpSourceConfig(cfg as never);
  if (kind === "graphql") return migrateGraphqlSourceConfig(cfg as never);
  return migrateOpenApiSourceConfig(cfg as never);
};

const main = async (): Promise<void> => {
  const [sources, secrets, bindings, connections, policies, storage, toolSources] =
    await Promise.all([
      sql<Row[]>`select scope_id, id, plugin_id, kind, name from source`,
      sql<Row[]>`select id, scope_id, name, provider, owned_by_connection_id from secret`,
      sql<
        Row[]
      >`select scope_id, source_scope_id, source_id, slot_key, kind, secret_id, secret_scope_id, connection_id, text_value from credential_binding`,
      sql<
        Row[]
      >`select id, scope_id, provider, identity_label, access_token_secret_id, refresh_token_secret_id, expires_at, provider_state from connection`,
      sql<Row[]>`select scope_id, pattern, action from tool_policy`,
      sql<
        Row[]
      >`select ps.scope_id, ps.key as source_id, ps.data, s.kind from plugin_storage ps join source s on ps.key = s.id and ps.scope_id = s.scope_id where ps.collection = 'source'`,
      sql<Row[]>`select distinct source_id from tool`,
    ]);

  // Build the per-source migrated config (keyed exactly as the weave looks it up).
  const migratedConfigs = new Map<string, MigratedSourceConfig>();
  for (const r of storage) {
    const key = migrationSourceKey(String(r.scope_id), String(r.source_id));
    migratedConfigs.set(key, buildConfig(String(r.kind), r.data as Record<string, unknown>));
  }

  const sourceRows: V1SourceRow[] = sources.map((s) => ({
    scopeId: String(s.scope_id),
    id: String(s.id),
    pluginId: String(s.plugin_id),
    name: s.name == null ? String(s.id) : String(s.name),
  }));

  const input: MigrationInput = {
    nowMs: Date.now(),
    sources: sourceRows,
    migratedConfigs,
    connections: connections.map((c) => ({
      id: String(c.id),
      scopeId: String(c.scope_id),
      provider: String(c.provider),
      identityLabel: c.identity_label == null ? null : String(c.identity_label),
      accessTokenSecretId:
        c.access_token_secret_id == null ? null : String(c.access_token_secret_id),
      refreshTokenSecretId:
        c.refresh_token_secret_id == null ? null : String(c.refresh_token_secret_id),
      expiresAt: c.expires_at == null ? null : Number(c.expires_at),
      providerState: (c.provider_state as never) ?? null,
    })),
    bindings: bindings.map((b) => ({
      scopeId: String(b.scope_id),
      sourceScopeId: b.source_scope_id == null ? undefined : String(b.source_scope_id),
      sourceId: String(b.source_id),
      slotKey: String(b.slot_key),
      kind: b.kind as "secret" | "connection" | "text",
      secretId: b.secret_id == null ? null : String(b.secret_id),
      secretScopeId: b.secret_scope_id == null ? null : String(b.secret_scope_id),
      connectionId: b.connection_id == null ? null : String(b.connection_id),
      textValue: b.text_value == null ? null : String(b.text_value),
    })),
    secrets: secrets.map((s) => ({
      id: String(s.id),
      scopeId: String(s.scope_id),
      name: String(s.name),
      provider: String(s.provider),
      ownedByConnectionId:
        s.owned_by_connection_id == null ? null : String(s.owned_by_connection_id),
    })),
    policies: policies.map((p) => ({
      scopeId: String(p.scope_id),
      pattern: String(p.pattern),
      action: String(p.action),
    })),
    toolSourceIds: toolSources.map((t) => String(t.source_id)),
  };

  const plan = planMigration(input);
  const r = plan.report;

  const roleCounts = plan.secretOps.reduce<Record<string, number>>((acc, op) => {
    acc[op.role] = (acc[op.role] ?? 0) + 1;
    return acc;
  }, {});

  console.log("=== v1 → v2 migration DRY-RUN (read-only) ===");
  console.log(`integrations:      ${r.integrations}`);
  console.log(`connections:       ${r.connections}`);
  console.log(`oauth clients:     ${r.oauthClients}`);
  console.log(`secret ops:        ${r.secretOps}  ${JSON.stringify(roleCounts)}`);
  console.log(`stale connections: ${r.staleConnections} (unbound v1 rows → tokens orphaned)`);
  console.log(
    `policies:          ${r.policies.ok} ok · ${r.policies.static} static · ${r.policies.deadInert} dead-inert`,
  );
  console.log(`warnings:          ${r.warnings.length}`);
  for (const w of r.warnings) console.log(`  - ${w}`);

  if (APPLY) {
    console.error(
      "APPLY is not yet wired: needs the structural SQL pass + the WorkOS-Vault re-key " +
        "(live creds). Run against a clone, never prod, once that's reviewed.",
    );
    await sql.end();
    process.exit(1);
  }

  await sql.end();
};

await main();

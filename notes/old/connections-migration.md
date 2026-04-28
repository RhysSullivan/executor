# Connections migration (pre-refactor OAuth2 → Connection rows)

Context for the `rs/connections` branch. Pre-refactor, the OpenAPI
plugin stored OAuth2 state inline on each source (access/refresh token
secret ids, expiresAt, tokenType, scope string, etc.) under the source's
`invocation_config.oauth2` and the top-level `openapi_source.oauth2`
column. The refactor moves all of that live state onto a new `connection`
table and narrows the source's OAuth2 config to a thin pointer
(`{kind: "oauth2", connectionId, securitySchemeName, flow, tokenUrl,
authorizationUrl, clientIdSecretId, clientSecretSecretId, scopes}`).

## Why a data migration

The new `OAuth2Auth` schema can't decode the legacy shape (missing
`connectionId`, extra token fields). Without a data step, existing
OpenAPI OAuth sources would decode-fail on read and lose their Sign in
button. Users would have to re-add the source from scratch. The ask was
to preserve auth state across the upgrade.

## What the migration does, per source

1. `INSERT INTO connection` with the new pointer's `connectionId`,
   `provider = "openapi:oauth2"`, and `provider_state` = `{flow,
   tokenUrl, clientIdSecretId, clientSecretSecretId, scopes}` lifted
   from the legacy row. `access_token_secret_id` + `refresh_token_secret_id`
   reuse the legacy secret ids — tokens themselves never move, only
   ownership links flip.
2. `UPDATE secret SET owned_by_connection_id = <new id>` for the 1–2
   referenced secret rows.
3. `UPDATE openapi_source SET oauth2 = ..., invocation_config = ...`
   rewrites both OAuth2 copies to the new pointer shape.

All three steps run in one transaction per source so a partial failure
rolls that source back cleanly and the rest continue.

`authorizationUrl` is the one field the legacy row doesn't carry — it's
extracted at migration time from the stored OpenAPI spec
(`components.securitySchemes[name].flows.authorizationCode.authorizationUrl`).
If the `spec` column actually holds a URL (an early-branch data bug),
the plugin's `resolveSpecText` fetches it. `clientCredentials` flows
need no authorizationUrl; they migrate unconditionally.

## Where the migration lives

Deliberately **not** in the plugin SDK — the plugin stays on the current
shape only. Two sibling scripts own the legacy schema inline:

- `apps/cloud/scripts/migrate-connections.ts` — standalone CLI. Default
  dry-run; `--apply` runs writes. Intended to run in the deploy pipeline
  after `drizzle-kit migrate`.
- `apps/local/src/server/migrate-connections.ts` — imported by
  `apps/local/src/server/executor.ts` and invoked right after drizzle's
  `migrate()`. Self-gates on presence of the `connection` table and the
  `secret.owned_by_connection_id` column so it's inert against fresh DBs
  that already boot on the new schema.

Both scripts are idempotent — rows already on the current shape decode
cleanly and are skipped.

Once both environments have run the migration on the real data, both
files + this note can be deleted.

## Classification buckets

The dry-run output mirrors the apply-mode decisions:

- `no-oauth` — row has no OAuth2 config; skip.
- `current` — row already on the new pointer shape; skip.
- `legacy-migratable` — decodes against the legacy schema and (for
  `authorizationCode`) we can recover `authorizationUrl` from the spec.
  Apply-mode runs the 3-step transaction above.
- `legacy-blocked` — decodes against the legacy schema but the
  `authorizationUrl` can't be recovered (corrupt spec, missing security
  scheme, etc.). Dry-run reports; apply-mode halts the deploy.
- `unknown` — doesn't match either schema. Dry-run dumps the key set;
  apply-mode halts the deploy.

## Deploy sequencing

- **Local**: drizzle migrations + this backfill both run inline at
  `createLocalExecutorLayer()` boot. No manual step.
- **Cloud**: run `drizzle-kit migrate` to land `0003_add_connections.sql`,
  then `bun run scripts/migrate-connections.ts` (dry-run) to confirm the
  plan, then `--apply`. Auth is unavailable for the ~1–5min window
  between the schema migration and the backfill completing; that window
  is within tolerance.

## Consequences of the tolerant-decode removal

`store.ts` now uses `Schema.decodeUnknownSync(OAuth2Auth)` + a strict
`decodeInvocationConfig`. Any row that bypasses the backfill and still
holds the legacy shape will throw a `ParseError` on read. That's
intentional — it forces operator attention rather than silently dropping
auth.

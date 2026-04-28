# Storage Migration Notes (PR #262 — sdk-refactor-inplace)

## What was done

### 1. DBSchema alignment with better-auth
- Vendored better-auth's `BetterAuthPluginDBSchema` pattern into `storage-core/src/schema.ts`
- Made `modelName` optional (falls back to the key), renamed `disableMigrations` → `disableMigration`, dropped `order`
- Removed explicit `modelName` from all plugin schemas (core-schema, openapi, mcp, graphql, google-discovery, workos-vault) — keys already match table names

### 2. @executor/cli package (packages/core/cli/)
- Mirrors better-auth's CLI approach: load config → collect plugin schemas → generate drizzle TS
- `executor generate --config ./executor.config.ts --output ./src/services/executor-schema.ts`
- Generator ported from better-auth's drizzle generator, adapted for our DBSchema
- Handles pg/sqlite/mysql dialects, indexes, references, relations, default values
- Uses jiti for config loading (supports TS configs)

### 3. apps/cloud wired up
- `executor.config.ts` defines plugins with stub credentials (only used for schema shape)
- `drizzle.config.ts` points at both `schema.ts` (cloud tables) and `executor-schema.ts` (executor tables)
- Fresh `drizzle/0000_initial.sql` with all tables (cloud + core + plugin + blob), indexes, FKs

### 4. apps/local wired up
- `executor.config.ts` defines plugins + dialect sqlite
- `drizzle.config.ts` for drizzle-kit generate/push
- Generated `executor-schema.ts` with all sqlite tables + blob table
- `drizzle/0000_*.sql` initial migration
- At startup: `migrate(db, { migrationsFolder })` from `drizzle-orm/bun-sqlite/migrator` applies pending migrations before constructing the adapter

### 5. Adapter DDL removed
- `makeSqliteAdapter` and `makePostgresAdapter` no longer run DDL — they return `DBAdapter` directly (not `Effect.Effect<DBAdapter>`)
- `makeSqliteBlobStore` and `makePostgresBlobStore` no longer run DDL — they return `BlobStore` directly
- `buildCreateTableStatements` deleted from `storage-file/compile.ts`
- Blob table included in both local and cloud generated schemas — managed by drizzle-kit alongside all other tables

## Migration path — what's next

### The plan: re-derive sources from executor.jsonc

The `@executor/config` package already maintains `executor.jsonc` as a source of truth for source configurations. The `config-store.ts` decorator intercepts `putSource`/`removeSource` on each plugin and mirrors to this file. So for existing users, `executor.jsonc` already has everything.

### Local app migration
1. On first run, `migrate()` creates all tables from the initial migration
2. Add a **sync-from-config step** after executor creation:
   - `loadConfig(configPath)` reads `executor.jsonc`
   - For each source, call the plugin's add method (`executor.openapi.addSpec()`, `executor.mcp.addSource()`, etc.)
   - This re-fetches specs, re-parses tools, populates typed tables
3. Secrets survive untouched — they live in keychain/1password/file-secrets, not in the DB. The `secret` routing table gets re-populated when sources are added.

### What won't survive (acceptable losses)
- Tool invocation history / blobs (old KV format)
- OAuth sessions (ephemeral, users re-auth)
- Stale source state (re-fetching is actually a benefit)

### Cloud migration
- Only ~2 users, just drop old tables and re-add manually
- Or write a one-off SQL migration

## Key files

| File | Role |
|------|------|
| `packages/core/cli/src/commands/generate.ts` | CLI generate command |
| `packages/core/cli/src/generators/drizzle.ts` | Drizzle schema generator |
| `packages/core/sdk/src/config.ts` | `defineExecutorConfig` helper |
| `packages/core/config/src/schema.ts` | `executor.jsonc` schema |
| `packages/core/config/src/config-store.ts` | Plugin store → config file decorator |
| `packages/core/config/src/load.ts` | Config loading |
| `apps/cloud/executor.config.ts` | Cloud config for CLI |
| `apps/cloud/src/services/executor-schema.ts` | Generated drizzle schema |
| `apps/cloud/drizzle/0000_*.sql` | Fresh migration |
| `apps/local/executor.config.ts` | Local config for CLI |
| `apps/local/src/server/executor-schema.ts` | Generated drizzle schema |
| `apps/local/drizzle/0000_*.sql` | Fresh migration |
| `apps/local/src/server/executor.ts` | Local executor bootstrap with `migrate()` |

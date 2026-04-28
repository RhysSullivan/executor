# Index Cleanup

Audit of `apps/cloud/drizzle/0000_lame_rage.sql` against the query
patterns in `packages/core/sdk/src/executor.ts`. Summary: mostly
over-indexed, one important miss.

## Redundant: single-column `scope_id` indexes (× 15)

Every scoped table has a composite PK `(scope_id, id)` AND a separate
`<table>_scope_id_idx`. Postgres composite btrees support leftmost-
prefix queries — `WHERE scope_id = ?` uses the PK directly. The
single-column indexes are dead weight: extra storage, extra write
amplification on every insert, never chosen by the planner when the
composite PK is available.

Tables affected (all drop candidates):

- `definition_scope_id_idx`
- `graphql_operation_scope_id_idx`, `graphql_source_scope_id_idx`
- `mcp_binding_scope_id_idx`, `mcp_oauth_session_scope_id_idx`, `mcp_source_scope_id_idx`
- `openapi_oauth_session_scope_id_idx`, `openapi_operation_scope_id_idx`, `openapi_source_scope_id_idx`
- `secret_scope_id_idx`
- `source_scope_id_idx`
- `tool_scope_id_idx`
- `workos_vault_metadata_scope_id_idx`

Root cause: `core-schema.ts` and plugin schemas mark `scope_id: {
index: true }`. The drizzle generator should probably *skip* emitting
a single-column index on a column that's already the leftmost column
of a composite primary key. Fix in two places:

1. **Generator** (`packages/core/cli/src/generators/drizzle.ts`) — skip
   emitting `index(...)` for `field.index` when the field is the first
   column of a composite PK.
2. **Schemas** — drop `index: true` from the `scope_id` field
   declarations (fallback if we want to be explicit).

Cheaper to fix at the generator level — behaves correctly regardless
of what plugin authors write.

## Missing: `memberships.organization_id`

`memberships` has PK `(account_id, organization_id)`. Queries:

- `WHERE account_id = ?` — "orgs for this user" — uses PK leftmost ✓
- `WHERE organization_id = ?` — "members of this org" — **table scan**

The second query is at least as common as the first. Fix:

```sql
CREATE INDEX "memberships_organization_id_idx"
  ON "memberships" USING btree ("organization_id");
```

Or flip the PK column order, but that's a bigger migration.

## Probably dead weight — worth auditing queries

Nothing in the executor source currently queries by these fields alone.
Keep or drop based on where these are actually exercised (admin UIs?
analytics?):

- `definition_plugin_id_idx`
- `source_plugin_id_idx`
- `tool_plugin_id_idx`
- `secret_provider_idx`

If kept, leave a note on the call site so future maintainers know why.

## Fine as-is

- `*_source_id_idx` on child tables (`definition`, `mcp_binding`,
  `graphql_operation`, `openapi_operation`, `tool`) — exercised by
  `findMany(where: source_id = X)` via the scoped adapter.
- Composite `(scope_id, source_id)` would be marginally better than the
  current `source_id` single-column index (lets the planner use one
  index for both filters), but not worth the churn unless we're
  redoing the DDL anyway.

## Rollout

Not blocking PR #262. Do this as a follow-up: one small PR that
(a) teaches the drizzle generator the "skip index on composite-PK-
leading column" rule, (b) regenerates the schemas, (c) adds the
`memberships_organization_id_idx`, (d) produces a single cleanup
migration. Zero code changes to the runtime.

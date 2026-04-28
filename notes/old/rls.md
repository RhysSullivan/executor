# Postgres RLS — optional, not required

## TL;DR

**RLS is not needed for the current architecture.** Tenant isolation is
enforced at the application layer: every query against a scoped table
(see `notes/scopes.md`) is routed through the scope adapter which ANDs
`scope_id = <current scope>` into every read and stamps it on every
write. Only the worker talks to the DB; clients authenticate to the
worker via WorkOS JWT, never to Postgres directly. One DB role
(`postgres`) owns every row. RLS would be a second lock on a door that's
already locked.

The only reason to turn RLS on is **defense-in-depth** — a belt against
a future bug where a drizzle query forgets to filter by `scope_id`.
Without RLS, such a query silently returns cross-tenant rows. With RLS,
it returns zero rows.

## When RLS matters

RLS earns its weight when untrusted clients connect directly to Postgres
with per-user credentials (the Supabase / PostgREST model). Not our
shape.

Consider turning it on if any of these change:

- Clients start hitting Postgres directly (JWT-authed session, row-level
  policies as the only authorisation layer).
- We run multiple DB roles that need row-level isolation between them.
- We decide the cost of a missed `scope_id` filter in app code is high
  enough to want a DB-level backstop.

## How it would work with scope merging

Scope merging (`ScopeStack` in `notes/scopes.md`) means reads fan out
across multiple scopes while writes target exactly one. RLS policies
mirror that asymmetry by reading two settings per request:

```sql
CREATE POLICY scope_read ON source FOR SELECT
  USING (scope_id = ANY(current_setting('app.scope_chain', true)::text[]));

CREATE POLICY scope_write ON source FOR INSERT
  WITH CHECK (scope_id = current_setting('app.write_scope', true));

CREATE POLICY scope_update ON source FOR UPDATE
  USING (scope_id = current_setting('app.write_scope', true))
  WITH CHECK (scope_id = current_setting('app.write_scope', true));

ALTER TABLE source ENABLE ROW LEVEL SECURITY;
```

And app-side, once per request inside a transaction (so `SET LOCAL`
takes):

```ts
yield* sql`SET LOCAL app.scope_chain = ${toPgArray(chain)}`;
yield* sql`SET LOCAL app.write_scope = ${writeScope}`;
```

`current_setting('…', true)` returns null when the setting is missing,
which is what you want — a connection that forgets to configure the
scope sees zero rows, not an error that might be handled into a 500.

## Rollout sketch (if we ever decide to enable it)

1. Add a migration that `ENABLE ROW LEVEL SECURITY` on every scoped
   table and installs the read/write policies above. The list of scoped
   tables is whatever `executor-schema.ts` exports with a `scope_id`
   column — same set the scope adapter already knows about.
2. Add an Effect layer that wraps the DbService to issue the two `SET
   LOCAL`s at connection acquire. `postgres.js`'s `sql.begin` already
   gives us the transaction boundary.
3. Leave `BYPASSRLS` off the worker's role so we actually get the
   enforcement; grant it on the role used by the migration / admin
   scripts.

Ballpark effort: a day including the migration + the Effect layer +
tests. Worth doing only if we hit a scope-leak bug in prod or change
the access model.

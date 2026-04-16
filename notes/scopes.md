# Scopes

Tenant isolation + the path to layered scopes.

## Today: flat, one scope per executor

Every multi-tenant row carries a `scope_id` column. Tables whose schema
declares `scope_id` are "scoped"; tables without it are shared across
scopes by construction.

- **SDK** — `createExecutor({ scope: Scope, adapter, blobs, plugins })`.
  One `Scope` per executor instance. `scopeAdapter(rootAdapter, {...},
  schema)` wraps the adapter before it reaches plugin storage or the
  core-table writers. Every read on a scoped table gets `where scope_id
  = scope.id` ANDed in; every write gets `scope_id = scope.id` stamped
  into the payload. Tx handles passed into transaction callbacks are
  also wrapped, so nested writes stay inside the same scope.

- **Plugins** — see a plain `DBAdapter`. They do not know or care about
  scope. Every plugin schema that wants isolation declares `scope_id:
  { type: "string", required: true, index: true }`. Forgetting the
  column means the adapter passes the plugin's reads/writes through
  unscoped (documented failure mode, not silent) — tests catch the
  concrete cases we care about.

- **Cloud** — the WorkOS organization is the outermost scope.
  `createScopedExecutor(scopeId, scopeName)` in
  `apps/cloud/src/services/executor.ts` is called per request with
  `{ org.id, org.name }` pulled from the session. One scope per request.

- **Local** — `apps/local/src/server/executor.ts` derives a single scope
  id from the working directory (`${basename(cwd)}-${sha256(cwd)[0..8]}`).
  One scope per executor process.

Coverage for the invariant lives in two places: `packages/core/sdk/src/
executor.test.ts` (SDK-level, in-memory adapter, two executors sharing
one adapter) and `apps/cloud/src/services/tenant-isolation.node.test.ts`
(HTTP-level, real `ProtectedCloudApi`, real PGlite). Both exercise
sources, tools, secrets, and plugin-owned source detail lookups.

## The primitive already accepts layering

`scopeAdapter` takes a `ScopeContext`:

```ts
interface ScopeContext {
  readonly read: readonly string[];  // precedence-ordered, innermost first
  readonly write: string;             // exactly one scope for writes
}
```

Today the read list is always length 1 and equals the write target. For
a single scope the wrapper emits `where scope_id = <id>`; for multiple
scopes it emits `where scope_id IN (...)`. The shape is a list on
purpose so that extending to a stack later touches **one** call site
(`createExecutor`'s adapter wrap) — not every plugin or every storage
backend.

Read-side dedup by id (shadowing on collision) is **not implemented**
today; no code path sees rows from more than one scope yet. When
layering lands the dedup step is a thin pass on top of `findMany` /
`list` results.

Write target is always a single scope. Layered writes mean "I decided
my write target is workspace, not org, not user" — that's a policy
decision the caller makes, not something storage guesses.

## Future: layered scopes

The goal is a design like:

```
org → workspace → workspace-of-workspace → user
```

As an ordered list, not a tree. Rows stay owned by exactly one scope.
Reads walk the list; on id collision the innermost wins (shadowing).
Writes land in exactly one scope chosen by the caller.

### Scenarios we want to support

- **Org-provided API key, team inherits.** Org admin adds an OpenAPI
  source with its auth at the org scope. Every user in every workspace
  in that org sees the source and the auth. Override at any inner scope
  (e.g., workspace overrides the URL, user overrides nothing) by
  writing a row with the same id at the inner scope — the outer row is
  shadowed on read.

- **Workspace Gmail, per-user auth.** Workspace admin adds the Gmail
  source at workspace scope but declines to store an oauth token
  there. When a user invokes Gmail, secret resolution walks the scope
  stack (user → workspace → org) and only finds a token if that user
  personally oauthed. Policy on the source row — `auth_scope_mandate:
  "user"` — forces this: secret lookup refuses to return
  workspace-level tokens even if one existed.

- **Local global + per-folder.** `~/.executor/global` holds the outer
  scope; the current folder's `executor.jsonc` holds the inner. Run
  `executor` in folder A and you see folder A's sources layered on the
  global set. Run in folder B, same global base, different inner.

### Data model implications

- **No new columns on existing tables.** `scope_id` is enough — each
  row still belongs to exactly one scope. Layering is a read-time and
  resolution-time concern, not a storage concern.

- **One new column** on `source` (or whatever the public config table
  becomes): `auth_scope_mandate: string | null`. If set, secret
  resolution for this source refuses scope levels at or above the
  mandate. `null` means "resolve normally, inner wins."

- **No parent pointer.** Do not add `parent_scope_id`. Parent pointers
  imply a tree; we want an ordered list held in memory per request.
  Scope identity is flat (each scope is just a string id); hierarchy
  is assembled by the host app per request.

### API / SDK surface changes when layering lands

- `Scope` becomes `ScopeStack { read: readonly Scope[]; write: Scope }`,
  or `createExecutor` grows a new shape and the old `Scope` path becomes
  a 1-element convenience.
- `ctx.scope.id` in plugin code is an implicit "the scope" today. The
  three callers in `executor.ts` that set `SecretRef.scopeId` from
  `scope.id` need to read the write target instead: `ctx.scope.write.id`
  or a rename.
- `scopeAdapter` signature is already list-shaped. Change the caller,
  not the wrapper.
- Secret resolution (`executor.secrets.get`) grows a shadowing pass:
  walk the stack, first non-null value wins. If the source has an
  `auth_scope_mandate`, skip scopes above it.

### Permissions / RBAC

Out of scope for the isolation primitive. Who can write to which scope
is a host-app concern (cloud: WorkOS role + workspace membership;
local: filesystem ownership). The SDK just takes the caller's declared
write target on faith — the host is responsible for enforcing that
it's legal.

### Cloud glue

`createScopedExecutor` takes `(scopeId, scopeName)` today with the
cloud passing the org id/name. When workspaces arrive:

- The request's `AuthContext` grows `workspaceId?` and `userId`.
- Cloud builds a `ScopeStack` from those: `[user, workspace, org]` read,
  write defaulting to the innermost writable (usually user; admin ops
  override).
- `createScopedExecutor` becomes `createScopedExecutor(scopes: ScopeStack)`
  or a similar shape.

The storage layer and every plugin are untouched by that change.

### Local glue

`apps/local` derives a single scope id from `cwd` today. Layering is
additive:

- Outer scope: `~/.executor/global` (or a named profile).
- Inner scope: the current folder, same derivation as today.
- `executor.jsonc` sync writes to the inner (folder) scope by default;
  a `--global` flag or explicit file location targets the outer.

## What NOT to do

- Do not collapse `source` and `secret` into one table to simplify
  layering. Their scope targets are independently chosen (see the
  Gmail scenario).
- Do not add a `parent_scope_id` column.
- Do not bake the concept of "organization" into SDK types or storage.
  It's a cloud concern today that maps onto the generic `scope_id`;
  the SDK must stay scope-generic so workspace + user scopes are
  cheap to add.
- Do not introduce scope-level defaults in the wrapper. The wrapper
  stamps and filters; shadowing lives one layer up.

## Related

- `packages/core/sdk/src/scoped-adapter.ts` — the wrapper.
- `packages/core/sdk/src/core-schema.ts` — `scope_id` on source, tool,
  definition, secret.
- `packages/core/sdk/src/executor.test.ts` — SDK-level tenancy tests.
- `apps/cloud/src/services/tenant-isolation.node.test.ts` — HTTP-level
  tenancy tests.
- Per-plugin schemas all carry `scope_id` today:
  openapi, mcp, graphql, google-discovery, workos-vault.

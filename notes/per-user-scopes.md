# Per-user scopes

Concrete plan for per-user OAuth, per-user bearer tokens, and per-user
source preferences. Builds on `scopes.md` (layered scopes) — this is
the first real use of the layering primitive.

## The shape

The user scope is just another layer in the existing scope stack.
Read chain per request: `[userScope, orgScope]`, innermost wins.
Writes target exactly one scope — caller picks personal vs shared.

No new `account_id` column on anything. No `Principal` concept in the
SDK. The scope id string IS the association.

## Scope id derivation

User scope id is deterministic, derived from the verified JWT:

```
${orgScopeId}:user:${accountId}
```

Namespaced under the org so the same WorkOS account in two
organizations gets two disjoint personal scopes — Alice's vercel
credential in Acme does not leak into her BigCo view.

No `account_scope` mapping table. No request-time lookup. The host
reconstructs the id from the authenticated principal every request.

Authz is enforced at the host boundary: the cloud app derives the
user-scope id from the JWT's `sub`, never from a client-supplied field.
A malicious caller can't claim another user's scope because the server
is the one constructing the chain.

## Materialization

Scope rows (the `scope` table) materialize lazily on first write. The
`scopeAdapter.stampScope` already writes `scope_id` into every row — we
just need an upsert into the `scope` table on first use of a new user
scope id, or an eager "on org-membership add" hook. Either works;
lazy is simpler.

Org scopes continue to materialize on org creation as today.

## Resolver (personal → shared)

This is already the behaviour `scopes.md` specifies for layered scopes:

- `findOne` / `findMany` get `WHERE scope_id IN (readChain)`.
- On id collision across scopes, the innermost wins (shadowing pass on
  top of `findMany` results).
- Secret `get` naturally returns the user-scope value if one exists,
  else falls back to the org-scope value.

No `account_id`-aware resolver code. The `secretsGet` / `secretsList` /
`secretsStatus` changes reduce to the general layered-scope shadowing
pass, not a per-feature walk.

## What this unlocks beyond secrets

Anything that lives on a `scope_id`-aware table becomes user-overridable
for free — no per-feature plumbing:

- Per-user tool approval preferences (policy rows at user scope shadow
  org defaults).
- Per-user "auto-run this source" / "never prompt on this tool" flags.
- Per-user default args, per-user elicitation behaviour.

Org admin sets defaults at org scope. User shadows them at user scope.
Same primitive.

## Write-target selection

The `ScopeContext.write` field (already in `scoped-adapter.ts`) picks
the target. UI affordance on the kickoff page / secrets page sends a
`scope: "personal" | "shared"` field, and the cloud handler maps:

- `"personal"` → `write = userScopeId`
- `"shared"`   → `write = orgScopeId`

Host-side authz gate: writing to org scope requires the writer to hold
an org-admin role. RBAC check lives at the API boundary, not in the
SDK. Deferred initially — every authed user can write to either scope
until RBAC lands.

## Sources and tools: a consequence

User-scope writes of sources and tools make them user-visible only.
Alice's personal Vercel source (registered with `write = userScope`) is
invisible to Bob. This is exactly the per-user OAuth story — it falls
out of the scope layering, not out of a new dimension.

Shared sources stay at org scope; everyone in the org sees them.

## Cloud glue (the concrete diff)

- `AuthContext` already carries `accountId`. No change.
- `createScopedExecutor(scopeId, scopeName)` grows into taking a scope
  stack: `createScopedExecutor({ read: [user, org], write: "user" | "org" })`.
  Default `write` depends on the endpoint — secret writes pick up a
  request field; passive reads don't care.
- `McpSessionInit` gains `accountId` so the DO can reconstruct the
  user-scope id on every request into the session.
- `makeExecutionStack` threads the scope stack down to `createExecutor`.

## What we're NOT doing

- No `account_id` column on `secret`, `workos_vault_metadata`, or any
  other table.
- No `Principal` type in `@executor/sdk`.
- No `SecretOwner` union in public API. "Personal" vs "shared" is a
  host-side UI concept; the SDK sees only a scope stack and a write
  target.
- No per-feature "account-aware" resolver code. The layered-scope
  shadowing pass is the mechanism.

## Migration

For existing secrets: nothing to migrate. Every existing row keeps its
`scope_id = orgScope` and becomes an org-shared credential by default.
Users who want a personal override write a new row at their user scope
after the layering lands.

Personal `scope` rows get inserted lazily on first use.

## Related

- `notes/scopes.md` — the general layering plan this specializes.
- `packages/core/sdk/src/scoped-adapter.ts` — already list-shaped,
  nothing to change in the wrapper itself.
- `packages/core/sdk/src/executor.ts` — needs the layered-scope
  shadowing pass on `findMany` / secret `get` / secret `list`.

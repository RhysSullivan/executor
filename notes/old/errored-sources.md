# Keep Errored Sources Visible

## What happens today

`config-sync` (apps/local/src/server/config-sync.ts) reads
`executor.jsonc` and calls the plugin's `addSource` / `addSpec` for
each entry. If one fails (auth, network, unparseable spec), the error
is logged and the rest keep loading:

```
[config-sync] Failed to load source "mcp_axiom_co": MCP discovery failed:
  Failed connecting to MCP server: Failed connecting via sse:
  SSE error: Non-200 status code (401)
[config-sync] 3/4 source(s) synced
```

The row never reaches the DB. `executor.jsonc` still has it, so next
boot retries — idempotent, but from the UI's perspective the source
has silently vanished.

## The gap

The user sees 3 sources in the UI. They have no way to know a 4th
existed, was tried, and failed. The only record of the failure is
stderr. Reasonable people end up confused — "did it delete my source?"

## What we want

The source stays visible after a failed add, marked as errored with a
human-readable reason. The UI shows it with a warning badge; a retry
button calls `refresh` or re-runs the config-sync entry for just that
source.

## Sketch

**Schema** — extend the `source` table:

```ts
source: {
  fields: {
    id: { type: "string", required: true },
    scope_id: { type: "string", required: true, index: true },
    // ...existing...
    status: { type: "string", required: true, defaultValue: "healthy" },  // "healthy" | "error"
    last_error: { type: "string" },        // message
    last_error_at: { type: "date" },       // for UI "last tried N minutes ago"
  },
}
```

**config-sync** — on failure, still write a row:

```ts
Effect.catchAll((e) => {
  const message = e instanceof Error ? e.message : String(e);
  return executor.sources.recordError({ source, message }).pipe(Effect.asVoid);
})
```

`executor.sources.recordError` is a new core method that writes a
source row with `status="error"` and `last_error`. Plugin-specific
data (spec JSON, endpoint URL, headers) is still pulled from the
config entry, so the row is mostly populated — just no tools
attached because discovery never ran.

**UI** — sources list badges errored entries, shows `last_error` on
hover/click, offers "Retry" which calls `executor.sources.refresh(id)`.

## Interaction with removes

An errored source is still user-visible, so `removeSource` should work
on it (user can delete the jsonc entry and the DB row together). Not
a special case — current `removeSource` already works regardless of
`status`.

## Scope

Not for the scope-refactor PR. Separate change:
- Schema migration adds two columns.
- `executor.sources.recordError` on the core SDK.
- Wire up in config-sync.
- UI badge + retry button in the sources list.

Doable in a day. Worth doing because silent source dropping is the
single most confusing UX we have today.

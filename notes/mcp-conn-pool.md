# MCP connection pool — investigation notes (2026-04-30)

## TL;DR

The MCP plugin **already pools connections within a session DO**. Production
telemetry attributing 17% of `plugin.mcp.connection.acquire` calls to a
fresh `plugin.mcp.connection.handshake` represents _cold-start sessions_,
not redundant in-session handshakes. No structural change is required;
this PR ships a strict regression test that pins the existing contract
plus a `plugin.mcp.cache_hit` span attribute so future telemetry can
distinguish hits from misses without cross-referencing handshake counts.

## What's already there

`packages/plugins/mcp/src/sdk/plugin.ts#makeRuntime`:

```ts
const connectionCache = yield* ScopedCache.make({
  lookup: (key: string) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        const connector = pendingConnectors.get(key);
        ...
      }),
      (connection) => Effect.promise(() => connection.close().catch(() => {})),
    ),
  capacity: 64,
  timeToLive: Duration.minutes(5),
}).pipe(Scope.extend(cacheScope));
```

Properties:

- One `ScopedCache` per plugin instance, captured by the closure
  `runtimeRef`. Lifecycle is the executor (one executor per session DO,
  built in `apps/cloud/src/services/executor.ts#createScopedExecutor`).
- LRU with `capacity: 64`, `timeToLive: 5 min`.
- Lookup runs inside a Scope held by `cacheScope`, so the pooled
  connection survives `Effect.scoped` boundaries inside `invokeMcpTool`.
- Cache key (`invoke.ts#connectionCacheKey`) is
  `remote:${invokerScope}:${endpoint}` for remote sources and
  `stdio:${command}` for stdio. Includes `invokerScope` so per-user
  OAuth/header secrets never collapse onto a shared connection.
- `invokeMcpTool` retries once on connection error: invalidates the
  cache entry and re-acquires. Stale connections are caught here and
  transparently re-handshaked.

## Why the pool is plausibly correct

`packages/plugins/mcp/src/sdk/elicitation.test.ts` already had a test
`"connection is reused across multiple tool calls to the same source"`
that asserts the underlying MCP server sees no new HTTP sessions across
three sequential `executor.tools.invoke` calls — passes against current
code.

This PR adds two stricter regression cases under
`packages/plugins/mcp/src/sdk/connection-pool.test.ts`:

1. Five sequential invokes of the same tool — one handshake total.
2. Different tools on the same source — still one handshake, different
   tool ids hit the same cache key.

Both pass without any source change. They serve as a deterministic
contract pin so a future refactor that breaks pooling (e.g., scoping
the cache to the per-invoke scope, dropping `Scope.extend(cacheScope)`,
mutating the cache key per call) trips immediately in CI.

## Re-reading the production trace

Trace `b7102047bed975da461c0519d1251de4`:

- `mcp.plugin.resolve_connector` 2.72s
- `plugin.mcp.connection.acquire` 2.72s
- `plugin.mcp.connection.handshake` 2.52s
- `executor.storage.transaction` 1.02s (token persist)
- `plugin.mcp.client.call_tool` 1.48s

Span nesting plus `resolve_connector ≈ acquire ≈ handshake` durations is
the cache-miss path: `resolveConnector` only runs (and emits its span)
when the cache lookup actually invokes the lookup closure, which only
happens on a miss.

8h aggregate:

- `plugin.mcp.connection.handshake` count 4
- `plugin.mcp.connection.acquire` count 24
- `mcp.plugin.resolve_connector` count 4

Acquire count is 6× handshake count. The cache _is_ hitting on 20 of 24
calls. The 4 misses are cold-start sessions (each MCP session DO's first
tool call, plus any session where the connection went stale and was
invalidated by the retry path). Six tool calls per session is consistent
with normal MCP usage.

## Why we can't drive misses below the cold-start floor

Every miss observed in prod is structurally unavoidable inside a single
DO:

- **First tool invocation in a fresh DO.** `init()` builds the executor
  and a fresh `ScopedCache`. The first invoke must handshake.
- **Stale-connection retry.** `invokeMcpTool` invalidates the cache
  entry on `client.callTool` failure and re-acquires; that re-acquire
  is necessarily a miss.
- **TTL expiry.** Set to 5 minutes. The session DO's idle alarm fires
  at 5 minutes too, so any cache entry that out-survives a session was
  going to be discarded with the DO anyway.

To go below this floor we'd need either:

1. **Pre-warm in `init()`.** Plausible but speculative — we don't know
   which sources the user will invoke, and warming all of them
   bottlenecks `init()` on the slowest server. Out of scope; would also
   reverse the savings if the user never calls those tools.
2. **Cross-DO connection pool.** Forbidden by the task — and the
   per-DO scope of `runtimeRef` is the right home for a per-user-org
   connection pool given the cache key includes `invokerScope`.

## What this PR ships

1. `packages/plugins/mcp/src/sdk/connection-pool.test.ts` — two
   strict regression tests pinning the per-session pooling contract.
2. `packages/plugins/mcp/src/sdk/invoke.ts` — adds
   `plugin.mcp.cache_hit: boolean` attribute to the
   `plugin.mcp.connection.acquire` span. Future Axiom queries can read
   the hit rate directly without comparing acquire vs handshake counts.

No behavior change.

## Follow-ups

- If the cold-start p99 still bites tail latency, consider warming the
  most-recently-used source(s) for a session DO during `init()` —
  scoped to the user's recent activity, e.g., on session restore.
- Watch `plugin.mcp.cache_hit=false` rate over a longer window. If it
  exceeds the implied cold-start floor (≈ 1 / avg-calls-per-session),
  there's a real bug to chase.

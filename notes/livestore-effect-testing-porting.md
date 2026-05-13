# LiveStore Effect Testing Patterns Worth Porting

LiveStore is useful as a reference repo for Effect-heavy test ergonomics, not
as a wholesale tooling model. Executor already has the stricter Effect lint
posture and a simpler Bun/Turbo toolchain. The part worth copying is the small
test harness shape that makes scoped Effect tests easier to write and easier to
debug when they hang.

Reference checkout:

```txt
.reference/livestore
```

## What to Port

### Effect test context helper

LiveStore's `packages/@livestore/utils-dev/src/node-vitest/Vitest.ts` wraps
`@effect/vitest` with:

- `withTestCtx(test)` for per-test Effect setup.
- `makeWithTestCtx(...)` for reusable layer/timeout config.
- A default timeout, longer in CI.
- `Effect.logWarnIfTakesLongerThan` before the timeout trips.
- `Effect.timeout(...)`.
- `Effect.provide(...)` for per-test layers.
- `Effect.scoped` so finalizers and spans close predictably.
- Optional tracing/log layer wiring.

Executor should port the shape, not the exact implementation. LiveStore is on
Effect 3, while Executor is on Effect 4 beta. The local helper should be tiny
and typed against the current `@effect/vitest` and `effect` APIs.

Likely home:

```txt
packages/core/sdk/src/testing.ts
```

If the helper starts pulling in cloud-specific, Node-server, or plugin-specific
dependencies, stop and keep those helpers package-local instead.

### Timeout diagnostics for slow Effect tests

Several Executor tests already have manual sleeps, `Promise.race`, test-level
timeouts, or long-running fixtures. A `withTestCtx`-style helper would make
failures more readable by logging before timeout rather than only surfacing a
late Vitest timeout.

Good initial targets:

- `apps/cloud/src/mcp-miniflare.e2e.node.test.ts`
- `apps/cloud/src/mcp-session.e2e.node.test.ts`
- `packages/plugins/openapi/src/sdk/oauth-refresh.test.ts`
- `packages/plugins/mcp/src/sdk/connection-pool.test.ts`
- `packages/core/execution/src/tool-invoker.test.ts`

The first slice should convert only one painful test cluster. If it makes the
test body clearer and failure output better, then expand.

### Scoped fixture/runtime pattern

LiveStore's `tests/sync-provider/src/sync-provider.test.ts` builds a shared
`ManagedRuntime` in `beforeAll`, disposes it in `afterAll`, then creates
per-test providers with isolated ids. That pattern is a good fit for expensive
Executor integration fixtures:

- local HTTP protocol servers,
- MCP servers,
- OAuth mock servers,
- Miniflare environments,
- database-backed cloud services,
- plugin SDK tests that need realistic server behavior.

Executor already uses `layer(TestLayer)(...)` in some OpenAPI and cloud tests.
Keep that where it works. Use the LiveStore runtime pattern only where the
fixture is expensive enough that rebuilding it per test is wasteful or flaky.

### Property-test wrapper later

LiveStore's `asProp` wrapper normalizes FastCheck options and makes shrinking
progress clearer. Do not port it preemptively.

It becomes useful if Executor adds property tests for:

- OpenAPI parameter encoding,
- form/multipart request bodies,
- schema round-trips,
- scope ordering and shadowing,
- tool/source dedupe,
- storage adapter conformance.

Until then, direct `@effect/vitest` property tests are enough.

### Possibly scoped React perf lint

LiveStore enables `react-perf` oxlint rules for JSX props:

- no new functions as props,
- no new objects as props,
- no JSX as props,
- no new arrays as props.

This might be useful in `packages/react`, but it should start as a scoped
experiment. Do not enable it repo-wide. The risk is turning useful UI work into
memoization churn.

## What Not to Port

### Biome

LiveStore uses Biome for formatting/import organization plus oxlint for linting.
Executor already uses `oxfmt` and oxlint:

```txt
bun run format
bun run format:check
bun run lint
```

Adding Biome would split formatter ownership without solving an Executor
problem.

### devenv / genie / effect-utils repo generation

LiveStore's config generation and `devenv` task setup are substantial
infrastructure. Executor's Bun/Turbo setup is smaller and easier to reason
about. Do not port that unless there is a concrete repo-management problem that
cannot be solved locally.

### LiveStore's lint rules wholesale

Executor's lint posture is already stronger and more domain-specific. Executor
currently bans or guides:

- raw Vitest imports,
- conditional tests,
- double casts,
- cross-package relative imports,
- missing effect-atom reactivity keys,
- Effect escape hatches,
- unsupported Effect APIs,
- `new Error`,
- `try`/`catch` and raw `throw`,
- `Promise.catch` / `Promise.reject`,
- raw fetch outside approved boundaries,
- manual tagged-error checks,
- duplicated schema/value-derived types.

LiveStore disables several things Executor intentionally cares about, including
some broad TypeScript strictness. Their rule set should stay reference-only.

### An Effect barrel module

LiveStore centralizes Effect exports through `@livestore/utils/effect`.
Executor mostly imports from `effect` directly. Do not introduce a broad
`@executor-js/.../effect` barrel just for symmetry. It would add another import
surface without a concrete need.

## First Implementation Slice

Add a tiny test helper, then use it in one test cluster.

Possible local API:

```ts
export const withTestCtx =
  (test: TestContext, options?: TestContextOptions) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.logWarnIfTakesLongerThan({
        duration: "...",
        label: "...",
      }),
      Effect.timeout("..."),
      Effect.provide(options?.layer ?? Layer.empty),
      Effect.scoped,
    );
```

Keep the helper small:

- no tracing dependency in the first pass,
- no generic framework package,
- no large fixture registry,
- no migration of every test.

Validation should be narrow:

```txt
vitest run <converted test file> --testNamePattern "<converted test>"
```

If the first conversion produces clearer test bodies and better failure output,
then expand it to the other long-running Effect integration tests.

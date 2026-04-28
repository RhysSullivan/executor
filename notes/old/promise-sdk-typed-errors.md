# Promise SDK — typed errors revisit

## Today

`@executor/sdk/promise` wraps every Effect-returning method in
`Effect.runPromise(...)`. That works but it's lossy at the Promise
boundary:

- The promise's *rejection type* is `unknown` (or `any` after
  `try/catch`). Consumers have to `instanceof InternalError` /
  `err._tag === "..."` to discriminate, even though the underlying
  Effect had a fully typed error union.
- Defects (uncaught throws, fiber interrupts) become rejections with
  whatever value the Effect ran with — sometimes useful, sometimes a
  string, depending on the cause.

In other words: the Effect-side surface knows your method can fail with
`McpOAuthError | InternalError | UniqueViolationError`; the promise
consumer sees `Promise<X>` and has to take it on faith.

## What we want (revisit)

Switch the wrapper to `Effect.runPromiseExit(...)`. The promise always
resolves with an `Exit<A, E>`:

```ts
const exit = await executor.openapi.addSpec({ ... })
if (Exit.isSuccess(exit)) {
  exit.value // properly typed `A`
} else {
  // exit.cause is Cause<McpOAuthError | InternalError | ...>
  // narrow with Cause.failureOption / Cause.match etc.
}
```

The error union survives the Promise boundary. Defects are visible in
the cause. Consumers can write totality-checked `match` on the typed
union without any runtime guessing.

## Open question for the revisit

Do we expose Effect's `Exit` / `Cause` directly to promise consumers,
or wrap them in a promise-native `Result<A, E>`?

**Expose `Exit`/`Cause`:**
- Pros: one fewer abstraction, no translation layer to maintain, cause
  preserves parallel/sequential composition.
- Cons: consumers depend on `effect`'s API even though they're using a
  "Promise" SDK — partly defeats the abstraction.

**Wrap in a `Result<A, E>`:**
- Pros: `@executor/sdk/promise` consumers don't import `effect` at all,
  surface stays small.
- Cons: another type to learn / document; loses some Cause structure
  (parallel/interrupt) unless we replicate it.

Lean toward exposing `Exit`/`Cause`, but worth thinking through what
the `runPromiseExit` consumers actually want to do at the call site
before deciding.

## Why punted

Current refactor is about getting Effect-side typed errors right
end-to-end (storage → SDK → API). The Promise façade is downstream of
that — once the typed unions are stable on the Effect side, the
`runPromiseExit` rewrite is a small, well-defined change.

Also: it's a breaking change for promise SDK consumers (return type
goes from `Promise<A>` to `Promise<Exit<A, E>>`). Better as its own
focused PR with a migration note.

## Files affected when we do it

- `packages/core/sdk/src/promise-executor.ts` (`promisifyDeep`,
  `createExecutor`)
- `packages/core/sdk/src/promise.ts` if it re-exports surface
- Any Promise-SDK consumer in `examples/` or downstream
- Doc updates in `notes/error-handling.md`

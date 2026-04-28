# Error handling — model + plumbing

## Principle

Errors are typed values that propagate through the call graph carrying
their full causal structure. **Exactly one layer at the edge** consumes
them and maps them to a public response. Plugin code never imports
Sentry, never calls `captureException`, never wraps handlers with
`sanitize*` helpers.

Two error categories:

- **Surfaceable**: typed Schema errors with a user-actionable message
  (`McpOAuthError`, `OpenApiParseError`, …). Carry through to the
  response with their own status (4xx) and message body. Not captured
  to any external sink — they're normal business outcomes.
- **Internal**: truly unexpected (storage failure, third-party returned
  garbage, sync throw inside a handler). Captured via `ErrorCapture`
  **at the HTTP edge only**, then propagated as the shared
  `InternalError({ traceId })` schema — opaque to clients, fully
  detailed in Sentry. One shape, one trace id, one place to look up
  the cause.

## Layering

```
 storage-core ──▶ sdk ──▶ api (HTTP edge) ──▶ host
   StorageError   StorageError     InternalError       ErrorCaptureLive
   (raw)          (raw)             (captured)          (Sentry)
```

The SDK stays storage-typed. The HTTP edge (`@executor/api`) is the
**only** layer that translates `StorageError → InternalError` and
captures the cause to telemetry. Non-HTTP consumers (CLI, Promise
SDK, tests) see raw `StorageError` in the typed channel and can react
however they want.

## Plumbing

### Storage layer (`@executor/storage-core`)

Emits two `Data.TaggedError` classes and nothing else observability-related:

- `StorageError({ message, cause })` — the catch-all for non-recoverable
  backend failures. The `cause` travels as runtime data so the HTTP
  edge can capture it, but it's never serialised to the wire.
- `UniqueViolationError({ model? })` — typed 4xx-shaped failure plugins
  want to react to (e.g. "source already exists").

Both are `Data.TaggedError`, not `Schema.TaggedError` — you physically
can't `addError(...)` them on an HttpApi group, which enforces "these
are internal types, not wire shapes".

`DBAdapter` / `CustomAdapter` / `TypedAdapter` declare
`Effect<X, StorageFailure>` where `StorageFailure = StorageError |
UniqueViolationError`. No `Error`, no telemetry service in R.

Storage-core has zero observability awareness — it just emits typed
values and lets consumers decide what to do with them.

### SDK (`@executor/sdk`)

The SDK is entirely observability-free.

- `createExecutor` requires no observability service. `R = never`.
- `PluginCtx.storage`, `ctx.core.*`, `ctx.secrets.*`, `ctx.transaction`
  all surface raw `StorageFailure` in the typed error channel. Plugins
  can `Effect.catchTag("UniqueViolationError", …)` and translate to
  their own user-facing errors.
- Executor public methods (`executor.tools.list()`,
  `executor.sources.refresh()`, etc.) also surface raw `StorageFailure`.

No `liftStorage`, no `wrapAdapterForPlugin`, no `ErrorCapture` tag
inside the SDK. The value proposition: an SDK consumer can write a CLI,
a script, a promise-based wrapper, whatever — and the typed channel
shows them exactly what can go wrong.

### HTTP edge (`@executor/api/observability`)

Owns the translation, the opaque wire schema, and the capture service.

- `InternalError({ traceId })` — the public opaque 500 schema, with an
  `HttpApiSchema.annotations({ status: 500 })` annotation so the
  framework encodes it correctly.
- `ErrorCapture` — tagged Effect service for recording unexpected
  causes. Shape:

  ```ts
  interface ErrorCaptureShape {
    readonly captureException: (cause: Cause<unknown>) => Effect<string>
  }
  ```

  Optional — resolved via `Effect.serviceOption`; missing service =
  empty trace ids. Nothing breaks if it's not wired.

- `capture(eff)` — the single translator. Catches `StorageError` on
  the typed channel, captures the cause via `ErrorCapture`, fails with
  `InternalError({ traceId })`. Catches `UniqueViolationError` and
  dies (plugins that want to surface it as a typed domain error should
  `Effect.catchTag` inside their own method first). Every other typed
  failure passes through.

  Every handler wraps its generator body with `capture(...)`:

  ```ts
  .handle("probeEndpoint", ({ payload }) =>
    capture(Effect.gen(function* () {
      const ext = yield* McpExtensionService;
      return yield* ext.probeEndpoint(payload.endpoint);
    })),
  )
  ```

  One line at the top of each handler. No service-level proxy, no
  `Captured<T>` type gymnastics — the translation is visible right
  where it happens, and TypeScript rejects handlers that forget
  (because `StorageError` isn't in the group's `.addError` list).

- `observabilityMiddleware(Api)` — defect safety net. An
  `HttpApiBuilder.middleware` layer that wraps the HttpApp once and
  catches any cause that escaped the typed channel (defects,
  interrupts, framework bugs) via `ErrorCapture`, returning a typed
  `InternalError({ traceId })`. Should rarely fire when the rest of
  the pipeline is well-typed.

### Plugin SDK

Plugin authors write normal Effect code. Their extension method error
unions look like:

```ts
Effect.Effect<X, MyPluginTypedError | StorageError, never>
```

Where `MyPluginTypedError` is the union of their own
`Schema.TaggedError` classes (with `HttpApiSchema.annotations({ status: 4xx })`).
`StorageError` is the raw storage tag — it bubbles up, and the HTTP
edge translates it.

Plugins never provide `ErrorCapture`, never import Sentry, never see
`InternalError` in their typed channel.

### API groups

Each group declares its typed errors once at the group level:

```ts
class McpGroup extends HttpApiGroup.make("mcp")
  .add(endpoint1)
  .add(endpoint2)
  // …
  .addError(InternalError)
  .addError(McpOAuthError)
  .addError(McpConnectionError)
  // …
{}
```

No per-endpoint `addError`. The framework encodes each tagged error by
its annotated status.

### Hosts

- **Cloud Worker** (`apps/cloud/src/observability.ts`) — provides
  `ErrorCaptureLive`, a Sentry-backed implementation. Wired at the API
  layer in `protected-layers.ts` so it's available to both
  `observabilityMiddleware` (defect catchall) AND the per-handler
  `capture(...)` translation. Service tags (`ExecutorService`,
  `McpExtensionService`, etc.) hold the raw SDK shapes; the cloud app
  just does `Layer.succeed(McpExtensionService, executor.mcp)` —
  handlers do the translation themselves. (Distinct from
  `apps/cloud/src/services/telemetry.ts`, which is the OTEL→Axiom span
  bridge — "telemetry" in the tracing sense.)
- **CLI** (`apps/local/src/server/main.ts`) — same pattern. Provides a
  console-based `ErrorCaptureLive` (`apps/local/src/server/observability.ts`)
  that prints the squashed cause + pretty cause to stderr and returns a
  short correlation id.
- **Tests / Promise SDK / examples** — non-HTTP consumers see raw
  `StorageError` / `StorageFailure` in the SDK's typed channel and
  can match on it directly.

### Anti-patterns

- `Effect.orDie` at handler boundaries — silently turns recoverable
  failures into 500s with no telemetry (defects bypass typed-channel
  encoding).
- Per-plugin `*InternalError` types — clients can't tell which plugin
  emitted a 500 anyway. Use the shared `InternalError`.
- `sanitize*` helpers in handler files that `catchAllCause` + map to a
  generic 500 — same swallowing problem in disguise. Prefer wrapping
  the handler's `Effect.gen` body with `capture(...)`.
- SDK code importing `Sentry.captureException` or referencing
  `InternalError` / `ErrorCapture` — translation lives strictly in
  `@executor/api`. If the SDK imports it, the layering is wrong.

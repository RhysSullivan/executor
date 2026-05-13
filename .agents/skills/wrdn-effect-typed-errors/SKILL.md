---
name: wrdn-effect-typed-errors
description: Fix lint findings that use untyped JavaScript error handling instead of Effect typed failures. Use when lint flags new Error, throw, try/catch, Promise.catch, Promise.reject, instanceof Error, unknown error message/stringification, or redundant helpers that only construct tagged errors.
allowed-tools: Read Grep Glob Bash
---

You fix one family of patterns: untyped JavaScript error handling in Effect code.

The preferred boundary is typed `Schema.TaggedError` / `Data.TaggedError` values in the Effect error channel. Construct the tagged error directly at the failure site unless a helper performs real classification or normalization.

## Trace before changing

1. **Identify the boundary.** Is this Effect domain code, React UI code, a third-party callback, or plain test/tooling code?
2. **Find the existing domain errors.** Check nearby `errors.ts`, `Schema.TaggedError`, `Data.TaggedError`, and API `.addError(...)` declarations before adding a new class.
3. **Decide whether a new error is needed.** Add a new tagged error only if callers have a distinct recovery path, HTTP status, UI affordance, retry policy, or telemetry classification.
4. **Preserve failure semantics.** If the old code failed, the new code should fail in the Effect error channel. Do not replace thrown failures with fallback values like `false`, `null`, `undefined`, `[]`, or `"unknown"` unless the existing contract already treats that condition as non-fatal.
5. **Preserve the typed channel.** Do not convert typed failures into `Error`, thrown exceptions, `String(error)`, or `.message` reads from unknown values.
6. **Recognize real boundaries.** Runtime workers, Vite/CLI tooling, callback APIs, and third-party interfaces may have to throw, catch, or reject at the boundary. Do not contort those files into fake Effect shapes. Keep the boundary idiom when it is contained and immediately wrapped into an Effect error channel, stable IPC envelope, or test/tooling result.
7. **Do not hide construction behind trivial helpers.** Inline `new DomainError(...)` unless the helper branches on input or maps an external error format into a domain error.

## Preserve behavior first

The lint rule is about **where the failure lives**, not whether the operation should still fail.

Bad fix: this removes the lint finding by silently changing invalid input into a non-match.

```ts
case "in":
  if (!Array.isArray(value)) return false;
  return value.some((v) => cmp(lhs, v));
```

Good fix: keep the invalid input as a failure, but make it typed.

```ts
case "in":
  if (!Array.isArray(value)) {
    return Effect.fail(
      new StorageError({ message: "Value must be an array", cause: clause }),
    );
  }
  return Effect.succeed(value.some((v) => cmp(lhs, v)));
```

When the containing helper was synchronous, make the helper return `Effect.Effect<Success, DomainError>` and thread that through callers. Do not collapse the error into a success value to avoid changing call sites.

## Boundary exceptions

The lint rule is not a mandate to make every file Effect-shaped. It is acceptable to keep `try/catch`, `throw`, `new Error`, `.catch`, or `String(error)` at a true adapter boundary when all of these are true:

- the surrounding API is inherently throwing, callback-based, Promise-based, process/IPC-based, or plain JS tooling
- the untyped behavior is contained to the boundary function or module
- control is immediately translated into a typed Effect failure, stable IPC payload, stable test assertion, or deliberately best-effort cleanup
- the suppression is narrow and explains the boundary

## Repo Effect API compatibility

Use the APIs that exist in this repo's pinned Effect runtime:

- Use `Effect.callback` for callback adapters. Do not use `Effect.async`.
- Use `Effect.andThen` or `Effect.gen` sequencing. Do not use `Effect.zipRight`.
- Use `Effect.timeoutOrElse` or `Effect.timeoutOption`. Do not use `Effect.timeoutFail`.

These are not style preferences; the unavailable APIs fail at typecheck or runtime.

Good boundary suppression:

```ts
// oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: JSON.parse feeds stable IPC failure envelope
try {
  const message = JSON.parse(line);
  handleHostMessage(message);
} catch (error) {
  writeIpcMessage({ type: "failed", error: formatBoundaryError(error) });
}
```

Bad boundary fix: do not replace natural boundary code with fake thenables, fake error objects, promise chains that emulate `try/catch`, or broad helper machinery solely to make lint pass.

```ts
return makeRejectedThenable(makeErrorLike("Tool path missing"));
```

For Effect domain code, fix the code. For boundary code, either wrap once with `Effect.try` / `Effect.tryPromise` at the entry point or use a narrow suppression with a reason.

## Fix shapes

### Throw / new Error

Bad:

```ts
throw new Error("Missing source");
```

Good in `Effect.gen`:

```ts
return yield * new SourceNotFoundError({ sourceId });
```

Good in combinators:

```ts
Effect.fail(new SourceNotFoundError({ sourceId }));
```

If a third-party interface requires throwing, keep the throw at the adapter edge only and convert back into a typed failure as soon as control returns to Effect. Prefer a narrow `oxlint-disable-next-line` with a `boundary:` reason over code contortions.

### Effect.fail inside generators

Prefer yielding the error directly in generator code:

```ts
return yield * new SourceNotFoundError({ sourceId });
```

Do not write:

```ts
return yield * Effect.fail(new SourceNotFoundError({ sourceId }));
```

Use `Effect.fail(...)` in non-generator combinator code:

```ts
Effect.flatMap(
  source,
  Option.match({
    onNone: () => Effect.fail(new SourceNotFoundError({ sourceId })),
    onSome: Effect.succeed,
  }),
);
```

### Promise.catch / Promise.reject

Bad:

```ts
await client.close().catch(() => {});
return Promise.reject(new Error("failed"));
```

Good:

```ts
Effect.tryPromise({
  try: () => client.close(),
  catch: (cause) => new ClientCloseError({ cause }),
});
```

If the failure is intentionally ignored:

```ts
Effect.ignore(
  Effect.tryPromise({
    try: () => client.close(),
    catch: (cause) => new ClientCloseError({ cause }),
  }),
);
```

### Effect die / orDie escape hatches

Bad in domain code:

```ts
program.pipe(Effect.orDie);
Effect.die(error);
```

Good:

```ts
program.pipe(Effect.mapError((cause) => new DomainError({ message: "Operation failed", cause })));
```

`Effect.die`, `Effect.dieMessage`, `Effect.orDie`, and `Effect.orDieWith` turn typed failures into defects. Use them only at a true runtime boundary where the host cannot represent typed failures, and keep that usage behind a narrow lint suppression with a `boundary:` reason. Do not use `orDie` to avoid threading an error type through normal Effect code.

### try/catch

Bad:

```ts
try {
  return JSON.parse(text);
} catch (cause) {
  return new ParseError({ message: String(cause) });
}
```

Good for schema-backed input:

```ts
Schema.decodeUnknownEffect(Schema.fromJsonString(InputSchema))(text).pipe(
  Effect.mapError(() => new ParseError({ message: "Failed to parse input" })),
);
```

Good for non-schema throwing APIs:

```ts
Effect.try({
  try: () => new URL(value),
  catch: (cause) => new UrlParseError({ value, cause }),
});
```

### Unknown error message / instanceof Error

Bad:

```ts
err instanceof Error ? err.message : String(err);
```

Also bad: destructuring `message` only hides the same unknown-state problem from a shallow property-access lint.

```ts
const { message } = err;
return message;
```

Prefer one of:

```ts
Effect.mapError((err) => new DomainError({ cause: err }));
```

```ts
Effect.catchTag("KnownError", (err) => Effect.fail(new DomainError({ message: err.message })));
```

Only read `.message` from a typed error union when that field is explicitly part of the user-facing contract. Most boundary errors should instead use a stable product message and keep the original value in a separate `cause`, trace, log, or telemetry channel. Do not inspect unknown thrown values for domain behavior or customer copy.

If the lint rule overfires inside a branch that has already narrowed to a specific typed error, keep the direct typed read and use a narrow suppression with a reason. Do not rewrite to destructuring just to avoid the lint selector.

Bad: leaks internal provider/native details to users.

```ts
Effect.tryPromise({
  try: () => client.call(),
  catch: (cause) =>
    new SourceError({
      message: cause instanceof Error ? cause.message : String(cause),
    }),
});
```

Good: user-facing message is stable; internal detail goes into `cause` only if the error type has an internal channel.

```ts
Effect.tryPromise({
  try: () => client.call(),
  catch: (cause) =>
    new SourceError({
      message: "Failed to connect to source",
      cause,
    }),
});
```

If the error schema is serialized to customers and only has `message`, do not put internal details there. Prefer adding a non-serialized/internal `cause` field or logging/telemetry over suppressing the lint rule.

### Manual tags and broad error laundering

Bad: manually probing `_tag` to recover from typed Effect failures.

```ts
Effect.mapError((err) =>
  "_tag" in err && err._tag === "SecretOwnedByConnectionError"
    ? new SourceError({ message: "Failed to resolve secret" })
    : err,
);
```

Good: catch the one typed case you intentionally translate.

```ts
effect.pipe(
  Effect.catchTag("SecretOwnedByConnectionError", () =>
    Effect.fail(new SourceError({ message: "Failed to resolve secret" })),
  ),
);
```

Do not wrap a typed error union into one local error only to satisfy a narrower helper signature. Widen the helper/cache/invocation error channel when callers can still use the original typed failure. Wrap only when the new error adds product meaning, such as turning a connection-owned secret into a source configuration problem.

For Effect data types, use public helpers instead of `_tag` checks:

```ts
if (Option.isNone(parsed)) return null;
if (Exit.isFailure(exit)) return ...
```

### Redundant error helpers

Bad:

```ts
const connectionError = (message: string) =>
  new McpConnectionError({ transport: "remote", message });

return yield * connectionError("Endpoint URL is required");
```

Good:

```ts
return (
  yield *
  new McpConnectionError({
    transport: "remote",
    message: "Endpoint URL is required",
  })
);
```

Helpers are allowed only when they do real work, such as:

- choosing between different tagged errors
- decoding/parsing an external error shape
- preserving protocol-specific fields
- normalizing third-party SDK failures into one domain error

## New error or existing error?

Reuse an existing tagged error when only the message changes.

Create a new tagged error when a caller can reasonably branch differently:

- different HTTP status
- retry vs no retry
- auth/sign-in affordance
- not-found vs conflict vs validation
- user-actionable vs internal failure
- different telemetry grouping that should not depend on message text

Do not create one tagged error per sentence of prose.

## What not to report

- Test assertions that intentionally construct errors as fixture values.
- Runtime adapter edges that must satisfy a third-party throwing API, IPC contract, process worker contract, or tooling contract, as long as the untyped behavior is contained and converted to typed Effect failure or a stable boundary envelope.
- Real normalization helpers like `toOAuth2Error(cause)` that inspect protocol fields and preserve structured semantics.
- React/effect-atom mutation handlers using `try/catch`; use `wrdn-effect-promise-exit` for that UI-specific boundary.

## Output requirements

When reviewing, report:

- **File and line** of the untyped error pattern.
- **Rule** being violated.
- **Existing domain error** to use, or the new tagged error that should exist.
- **Fix** in the relevant shape: direct `yield* new ErrorType(...)`, `Effect.tryPromise`, schema decode, or direct constructor inline.

When editing, keep the error type precise and avoid broad message parsing.

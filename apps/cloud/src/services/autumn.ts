// ---------------------------------------------------------------------------
// Autumn billing service — wraps the autumn-js SDK with Effect
// ---------------------------------------------------------------------------

import { Autumn as AutumnSDK } from "autumn-js";
import { Context, Data, Effect, Layer, Config, Redacted } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AutumnError extends Data.TaggedError("AutumnError")<{
  cause: unknown;
}> {}

export class AutumnInstantiationError extends Data.TaggedError("AutumnInstantiationError")<{
  cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export type IAutumnService = Readonly<{
  client: AutumnSDK;
  use: <A>(fn: (client: AutumnSDK) => Promise<A>) => Effect.Effect<A, AutumnError, never>;
}>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const secretKey = yield* Config.redacted("AUTUMN_SECRET_KEY");

  const client = yield* Effect.try({
    try: () => new AutumnSDK({ secretKey: Redacted.value(secretKey) }),
    catch: (cause) => new AutumnInstantiationError({ cause }),
  });

  const use = <A>(fn: (client: AutumnSDK) => Promise<A>) =>
    Effect.tryPromise({
      try: () => fn(client),
      catch: (cause) => new AutumnError({ cause }),
    }).pipe(Effect.withSpan(`autumn.${fn.name ?? "use"}`));

  return { client, use } satisfies IAutumnService;
});

export class AutumnService extends Context.Tag("@executor/cloud/AutumnService")<
  AutumnService,
  IAutumnService
>() {
  static Default = Layer.effect(this, make).pipe(Layer.annotateSpans({ module: "AutumnService" }));
}

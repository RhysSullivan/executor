// ---------------------------------------------------------------------------
// Autumn billing service — wraps the autumn-js SDK with Effect
// ---------------------------------------------------------------------------

import { Autumn } from "autumn-js";
import { Context, Data, Effect, Layer } from "effect";

import { server } from "../env";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AutumnError extends Data.TaggedError("AutumnError")<{
  cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export type IAutumnService = Readonly<{
  use: <A>(fn: (client: Autumn) => Promise<A>) => Effect.Effect<A, AutumnError, never>;
}>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const make = Effect.sync(() => {
  const secretKey = server.AUTUMN_SECRET_KEY;

  if (!secretKey) {
    return {
      use: () => Effect.die(new Error("Autumn not configured — AUTUMN_SECRET_KEY is empty")),
    } as IAutumnService;
  }

  const client = new Autumn({ secretKey });

  const use = <A>(fn: (client: Autumn) => Promise<A>) =>
    Effect.tryPromise({
      try: () => fn(client),
      catch: (cause) => new AutumnError({ cause }),
    }).pipe(Effect.withSpan(`autumn.${fn.name ?? "use"}`));

  return { use } satisfies IAutumnService;
});

export class AutumnService extends Context.Tag("@executor/cloud/AutumnService")<
  AutumnService,
  IAutumnService
>() {
  static Default = Layer.effect(this, make).pipe(Layer.annotateSpans({ module: "AutumnService" }));
}

// ---------------------------------------------------------------------------
// Autumn billing service — wraps the autumn-js SDK with Effect
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";
import { Autumn } from "autumn-js";
import { Context, Data, Effect, Layer } from "effect";

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
  /**
   * Fire-and-forget-safe execution usage tracker. Errors are caught and
   * logged; the returned Effect never fails. Callers typically
   * `Effect.runFork` it at the boundary so the billing call can't stall a
   * user-facing request.
   */
  trackExecution: (organizationId: string) => Effect.Effect<void, never, never>;
}>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const make = Effect.sync(() => {
  const secretKey = env.AUTUMN_SECRET_KEY;

  if (!secretKey) {
    const notConfigured = Effect.die(
      new Error("Autumn not configured — AUTUMN_SECRET_KEY is empty"),
    );
    return {
      use: () => notConfigured,
      trackExecution: () => Effect.void,
    } satisfies IAutumnService;
  }

  const client = new Autumn({ secretKey });

  const use = <A>(fn: (client: Autumn) => Promise<A>) =>
    Effect.tryPromise({
      try: () => fn(client),
      catch: (cause) => new AutumnError({ cause }),
    }).pipe(Effect.withSpan(`autumn.${fn.name ?? "use"}`));

  const trackExecution = (organizationId: string) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ "autumn.customer.id": organizationId });
      const outcome = yield* Effect.either(
        use((c) =>
          c.track({ customerId: organizationId, featureId: "executions", value: 1 }),
        ),
      );
      if (outcome._tag === "Left") {
        // Silent billing data loss is worth paging on — autumn.trackExecution
        // is fire-and-forget so the caller doesn't handle it themselves.
        console.error("[billing] track failed:", outcome.left);
        Sentry.captureException(outcome.left);
        yield* Effect.annotateCurrentSpan({ "autumn.track.failed": true });
      }
    }).pipe(Effect.withSpan("autumn.trackExecution"));

  return { use, trackExecution } satisfies IAutumnService;
});

export class AutumnService extends Context.Tag("@executor/cloud/AutumnService")<
  AutumnService,
  IAutumnService
>() {
  static Default = Layer.effect(this, make).pipe(Layer.annotateSpans({ module: "AutumnService" }));
}

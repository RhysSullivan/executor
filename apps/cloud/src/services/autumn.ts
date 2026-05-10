// ---------------------------------------------------------------------------
// Autumn billing service — wraps the autumn-js SDK with Effect
// ---------------------------------------------------------------------------

import * as Sentry from "@sentry/cloudflare";
import * as Cloudflare from "alchemy/Cloudflare/Workers/Runtime";
import { Autumn } from "autumn-js";
import { Context, Data, Effect, Layer } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AutumnError extends Data.TaggedError("AutumnError")<{
  message: string;
  cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export type IAutumnService = Readonly<{
  use: <A>(fn: (client: Autumn) => Promise<A>) => Effect.Effect<A, AutumnError, never>;
  /**
   * Fire-and-forget-safe execution usage tracker. Errors are caught and
   * logged; the returned Effect never fails. Callers can fork it inside the
   * current Effect runtime so the billing call can't stall a user-facing
   * request.
   */
  trackExecution: (organizationId: string) => Effect.Effect<void, never, never>;
}>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const env = yield* Cloudflare.WorkerEnvironment.typed<Env>();
  const secretKey = env.AUTUMN_SECRET_KEY;

  if (!secretKey) {
    const notConfigured = Effect.fail(
      new AutumnError({ message: "Autumn not configured: AUTUMN_SECRET_KEY is empty" }),
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
      catch: (cause) => new AutumnError({ message: "Autumn SDK request failed", cause }),
    }).pipe(Effect.withSpan(`autumn.${fn.name ?? "use"}`));

  const trackExecution = Effect.fn("autumn.trackExecution")(function* (organizationId: string) {
    yield* Effect.annotateCurrentSpan({ "autumn.customer.id": organizationId });
    yield* use((c) =>
      c.track({ customerId: organizationId, featureId: "executions", value: 1 }),
    ).pipe(
      Effect.catchTag("AutumnError", (error) =>
        Effect.gen(function* () {
          // Silent billing data loss is worth paging on — autumn.trackExecution
          // is fire-and-forget so the caller doesn't handle it themselves.
          yield* Effect.sync(() => {
            console.error("[billing] track failed:", error);
            Sentry.captureException(error);
          });
          yield* Effect.annotateCurrentSpan({ "autumn.track.failed": true });
        }),
      ),
    );
  });

  return { use, trackExecution } satisfies IAutumnService;
});

export class AutumnService extends Context.Service<AutumnService, IAutumnService>()(
  "@executor-js/cloud/AutumnService",
) {
  static Default = Layer.effect(this)(make);
}

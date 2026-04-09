// ---------------------------------------------------------------------------
// HTTP error-handling integration test
// ---------------------------------------------------------------------------
//
// Pins down two things we care about:
//
//   1. The wire response body contains ONLY the declared error schema.
//      No SQL, no stack traces, no `cause` / `error` fields.
//   2. A server-side logger sees the full Cause chain (drizzle error,
//      original message, etc.) — so bugs are still debuggable in
//      production logs even though clients get nothing.
//
// The test builds a real HttpApi with an endpoint whose handler fails
// via the exact `tryPromise + tapErrorCause + mapError` pattern used in
// user-store/workos wrappers, then calls it via fetch and inspects both
// the response body and captured log lines.
//
// This lets us validate error-handling *patterns* without touching the
// prod wiring.

import { describe, expect, it } from "vitest";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpServer,
} from "@effect/platform";
import {
  Cause,
  Effect,
  Layer,
  Logger,
  LogLevel,
  Ref,
  Schema,
} from "effect";

import { withServiceLogging } from "./errors";

// ---------------------------------------------------------------------------
// Fixture API — one endpoint that fails with a tagged error whose schema
// has only a `message` field. The handler runs a failing service call
// wrapped with `withServiceLogging` — the same pattern real service
// wrappers in context.ts and workos.ts use.
// ---------------------------------------------------------------------------

class FixtureError extends Schema.TaggedError<FixtureError>()(
  "FixtureError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

const FixtureGroup = HttpApiGroup.make("fixture").add(
  HttpApiEndpoint.get("boom")`/boom`
    .addSuccess(Schema.Struct({ ok: Schema.Boolean }))
    .addError(FixtureError),
);

const FixtureApi = HttpApi.make("fixture").add(FixtureGroup);

// Drizzle-shaped error: carries a .cause with SQL + params, like
// postgres.js + drizzle-orm would.
const makeDrizzleError = () => {
  const pgError = new Error(
    'duplicate key value violates unique constraint "accounts_pkey"',
  );
  (pgError as { code?: string }).code = "23505";
  const drizzleError = new Error(
    `Failed query: insert into "accounts" ("id") values ($1) returning "id"`,
  );
  (drizzleError as { query?: string }).query =
    'insert into "accounts" ("id") values ($1) returning "id"';
  (drizzleError as { params?: unknown[] }).params = ["user_abc123"];
  (drizzleError as { cause?: unknown }).cause = pgError;
  return drizzleError;
};

const failingUse = withServiceLogging(
  "user_store",
  () => new FixtureError({ message: "internal database error" }),
  Effect.tryPromise({
    try: () => Promise.reject(makeDrizzleError()),
    catch: (e) => e,
  }),
);

const FixtureGroupLive = HttpApiBuilder.group(
  FixtureApi,
  "fixture",
  (handlers) =>
    handlers.handle("boom", () => failingUse),
);

const FixtureApiLive = HttpApiBuilder.api(FixtureApi).pipe(
  Layer.provide(FixtureGroupLive),
);

// ---------------------------------------------------------------------------
// Test helper: run a request through the full HttpApi pipeline with a
// capturing logger, return the response + captured log messages.
// ---------------------------------------------------------------------------

interface CapturedLog {
  readonly level: string;
  readonly message: string;
  readonly causeText: string;
}

const runWithCapturedLogs = async (
  layer: Layer.Layer<HttpApi.Api, never, never>,
  request: Request,
): Promise<{ response: Response; logs: CapturedLog[] }> => {
  const logsRef = await Effect.runPromise(Ref.make<CapturedLog[]>([]));

  const capturingLogger = Logger.make(({ logLevel, message, cause }) => {
    const msg = Array.isArray(message)
      ? message.map((p) => String(p)).join(" ")
      : String(message);
    const causeText = Cause.isEmpty(cause)
      ? ""
      : Cause.pretty(cause, { renderErrorCause: true });
    Effect.runSync(
      Ref.update(logsRef, (xs) => [
        ...xs,
        { level: logLevel.label, message: msg, causeText },
      ]),
    );
  });

  const LoggerLive = Logger.replace(Logger.defaultLogger, capturingLogger);

  const handler = HttpApiBuilder.toWebHandler(
    layer.pipe(
      Layer.provideMerge(HttpServer.layerContext),
      Layer.provideMerge(LoggerLive),
      Layer.provideMerge(Logger.minimumLogLevel(LogLevel.All)),
    ),
  );

  const response = await handler.handler(request);
  const logs = await Effect.runPromise(Ref.get(logsRef));
  return { response, logs };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HTTP error boundary", () => {
  it("returns only declared fields on the wire", async () => {
    const { response } = await runWithCapturedLogs(
      FixtureApiLive,
      new Request("http://localhost/boom"),
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      _tag: "FixtureError",
      message: "internal database error",
    });

    // Explicit: none of the internal details leaked.
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("duplicate key");
    expect(bodyText).not.toContain("accounts_pkey");
    expect(bodyText).not.toContain("insert into");
    expect(bodyText).not.toContain("user_abc123");
    expect(bodyText).not.toContain("23505");
  });

  it("logs the full Cause chain server-side via tapErrorCause", async () => {
    const { logs } = await runWithCapturedLogs(
      FixtureApiLive,
      new Request("http://localhost/boom"),
    );

    const errorLogs = logs.filter((l) => l.level === "ERROR");
    expect(errorLogs.length).toBeGreaterThan(0);

    const rendered = errorLogs
      .map((l) => `${l.message} ${l.causeText}`)
      .join("\n");

    // The original drizzle query + params + underlying pg error should
    // all be recoverable from the log output.
    expect(rendered).toContain("user_store failed");
    expect(rendered).toContain("insert into");
    expect(rendered).toContain("duplicate key");
  });
});

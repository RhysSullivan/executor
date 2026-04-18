import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { autumnHandler } from "autumn-js/backend";

import { WorkOSAuth } from "../auth/workos";
import { server } from "../env";
import { HttpResponseError, isServerError, toErrorServerResponse } from "./error-response";
import { SharedServices } from "./layers";

const handleAutumnRequestEffect = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* Effect.mapError(
    HttpServerRequest.toWeb(request),
    () =>
      new HttpResponseError({
        status: 500,
        code: "invalid_request",
        message: "Invalid request",
      }),
  );

  const workos = yield* WorkOSAuth;
  const session = yield* workos.authenticateRequest(webRequest);

  if (!session || !session.organizationId) {
    return yield* Effect.fail(
      new HttpResponseError({
        status: 401,
        code: "unauthorized",
        message: "Unauthorized",
      }),
    );
  }

  const url = new URL(webRequest.url);
  const body =
    request.method !== "GET" && request.method !== "HEAD"
      ? yield* Effect.mapError(
          request.json,
          () =>
            new HttpResponseError({
              status: 400,
              code: "invalid_json",
              message: "Invalid request body",
            }),
        )
      : undefined;

  const { statusCode, response } = yield* Effect.promise(() =>
    autumnHandler({
      request: {
        url: url.pathname,
        method: request.method,
        body,
      },
      customerId: session.organizationId,
      customerData: {
        name: session.email,
        email: session.email,
      },
      clientOptions: {
        secretKey: server.AUTUMN_SECRET_KEY,
      },
      pathPrefix: "/autumn",
    }),
  );

  if (statusCode >= 400) {
    console.error("[autumn] upstream error:", statusCode, response);
    return yield* Effect.fail(
      new HttpResponseError({
        status: statusCode,
        code: "billing_request_failed",
        message: "Billing request failed",
      }),
    );
  }

  return HttpServerResponse.unsafeJson(response, { status: statusCode });
}).pipe(
  Effect.provide(SharedServices),
  Effect.catchAll((err) => {
    if (isServerError(err)) {
      console.error("[autumn] request failed:", err instanceof Error ? err.stack : err);
    }
    return Effect.succeed(toErrorServerResponse(err));
  }),
);

export const AutumnApiApp = handleAutumnRequestEffect;

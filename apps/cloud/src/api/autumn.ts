import { Effect } from "effect";
import { Autumn } from "autumn-js";
import { autumnHandler } from "autumn-js/backend";

import { WorkOSAuth } from "../auth/workos";
import { server } from "../env";
import { SharedServices } from "./layers";

let cachedAutumn: Autumn | null = null;

const getAutumn = () => {
  if (!cachedAutumn && server.AUTUMN_SECRET_KEY) {
    cachedAutumn = new Autumn({ secretKey: server.AUTUMN_SECRET_KEY });
  }
  return cachedAutumn;
};

export const trackExecutionUsage = (organizationId: string): void => {
  const autumn = getAutumn();
  if (!autumn) return;

  autumn
    .track({
      customerId: organizationId,
      featureId: "executions",
      value: 1,
    })
    .catch((err) => {
      console.error("[billing] track failed:", err);
    });
};

export const handleAutumnRequest = async (request: Request): Promise<Response> => {
  const program = Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    const session = yield* workos.authenticateRequest(request);

    if (!session || !session.organizationId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const body =
      request.method !== "GET" && request.method !== "HEAD"
        ? yield* Effect.promise(() => request.json())
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
      return Response.json({ error: "Billing request failed" }, { status: statusCode });
    }

    return Response.json(response, { status: statusCode });
  });

  return Effect.runPromise(program.pipe(Effect.provide(SharedServices), Effect.scoped)).catch(
    (err) => {
      console.error("[autumn] request failed:", err instanceof Error ? err.stack : err);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    },
  );
};

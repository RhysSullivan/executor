import { HttpApi, HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { WorkOSError } from "../auth/errors";
import { IdentityWebhookApi } from "./api";
import { IdentitySync } from "./sync";

export const IdentityApi = HttpApi.make("identity").add(IdentityWebhookApi);

export const IdentityWebhookHandlers = HttpApiBuilder.group(
  IdentityApi,
  "identityWebhooks",
  (handlers) =>
    handlers.handleRaw("workos", ({ request }) =>
      Effect.gen(function* () {
        const secret = env.WORKOS_WEBHOOK_SECRET;
        if (!secret) return HttpServerResponse.text("Missing webhook secret", { status: 500 });

        const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
          Effect.mapError(() => new WorkOSError()),
        );
        const sync = yield* IdentitySync;
        const result = yield* sync.constructAndApplyWebhook(webRequest, secret);
        return HttpServerResponse.unsafeJson({ result });
      }),
    ),
);

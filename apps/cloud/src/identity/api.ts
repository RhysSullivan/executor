import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { UserStoreError, WorkOSError } from "../auth/errors";

export class IdentityWebhookApi extends HttpApiGroup.make("identityWebhooks").add(
  HttpApiEndpoint.post("workos")`/webhooks/workos`
    .addError(UserStoreError)
    .addError(WorkOSError),
) {}

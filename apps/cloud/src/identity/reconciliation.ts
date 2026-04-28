import { Context, Effect, Layer } from "effect";

import { UserStoreService } from "../auth/context";
import { WorkOSError, type UserStoreError } from "../auth/errors";
import { WorkOSAuth } from "../auth/workos";
import { IdentitySync } from "./sync";

export type IdentityReconcileResult = {
  readonly processed: number;
  readonly duplicate: number;
  readonly ignored: number;
  readonly cursor: string | null;
};

export class IdentityReconciliation extends Context.Tag(
  "@executor/cloud/IdentityReconciliation",
)<
  IdentityReconciliation,
  {
    readonly replayWorkOSEvents: (options?: {
      readonly rangeStart?: string;
      readonly limit?: number;
    }) => Effect.Effect<IdentityReconcileResult, UserStoreError | WorkOSError>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const users = yield* UserStoreService;
      const workos = yield* WorkOSAuth;
      const sync = yield* IdentitySync;

      return IdentityReconciliation.of({
        replayWorkOSEvents: (options = {}) =>
          Effect.gen(function* () {
            const after =
              options.rangeStart == null
                ? yield* users.use((store) => store.getIdentityCursor("workos"))
                : null;
            const result = yield* workos.listIdentityEvents({
              after: after ?? undefined,
              rangeStart: options.rangeStart,
              limit: options.limit ?? 100,
              order: "asc",
            });

            let processed = 0;
            let duplicate = 0;
            let ignored = 0;

            for (const event of result.data) {
              const status = yield* sync.applyEvent({
                id: String(event.id),
                event: event.event,
                data: event.data as Record<string, unknown>,
              });
              if (status === "processed") processed++;
              if (status === "duplicate") duplicate++;
              if (status === "ignored") ignored++;
            }

            const cursor = result.listMetadata.after ?? after;
            if (cursor) {
              yield* users.use((store) => store.setIdentityCursor("workos", cursor));
            }

            return { processed, duplicate, ignored, cursor };
          }),
      });
    }),
  );
}

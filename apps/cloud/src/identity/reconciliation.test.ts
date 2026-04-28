import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { UserStoreService } from "../auth/context";
import { WorkOSAuth } from "../auth/workos";
import { IdentityReconciliation } from "./reconciliation";
import { IdentitySync } from "./sync";

const makeReconciliation = () => {
  let cursor: string | null = "cursor_0";
  const applied: string[] = [];
  const listCalls: Array<{ after?: string; rangeStart?: string }> = [];

  const UserStoreTest = Layer.succeed(UserStoreService, {
    use: <A>(fn: (store: {
      getIdentityCursor: (provider: string) => Promise<string | null>;
      setIdentityCursor: (provider: string, cursor: string | null) => Promise<unknown>;
    }) => Promise<A>) =>
      Effect.promise(() =>
        fn({
          getIdentityCursor: async () => cursor,
          setIdentityCursor: async (_provider, next) => {
            cursor = next;
            return { provider: "workos", cursor: next };
          },
        }),
      ),
  } as unknown as UserStoreService["Type"]);

  const WorkOSTest = Layer.succeed(WorkOSAuth, {
    listIdentityEvents: (options: { after?: string; rangeStart?: string }) =>
      Effect.sync(() => {
        listCalls.push(options);
        return {
          data: [
            { id: "event_1", event: "user.created", data: { id: "user_1" } },
            { id: "event_2", event: "unknown.event", data: {} },
          ],
          listMetadata: { after: "cursor_1" },
        };
      }),
  } as unknown as WorkOSAuth["Type"]);

  const IdentitySyncTest = Layer.succeed(IdentitySync, {
    applyEvent: (event: { id: string; event: string }) =>
      Effect.sync(() => {
        applied.push(event.id);
        return event.event === "unknown.event" ? "ignored" : "processed";
      }),
    constructAndApplyWebhook: () => Effect.succeed("ignored" as const),
  } as IdentitySync["Type"]);

  return {
    get cursor() {
      return cursor;
    },
    applied,
    listCalls,
    layer: IdentityReconciliation.Live.pipe(
      Layer.provideMerge(UserStoreTest),
      Layer.provideMerge(WorkOSTest),
      Layer.provideMerge(IdentitySyncTest),
    ) as Layer.Layer<IdentityReconciliation, never, never>,
  };
};

describe("IdentityReconciliation", () => {
  it.effect("pulls after the stored cursor and advances it", () =>
    Effect.gen(function* () {
      const reconciliation = makeReconciliation();

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const service = yield* IdentityReconciliation;
          return yield* service.replayWorkOSEvents();
        }),
        reconciliation.layer,
      );

      expect(reconciliation.listCalls).toEqual([
        { after: "cursor_0", rangeStart: undefined, limit: 100, order: "asc" },
      ]);
      expect(reconciliation.applied).toEqual(["event_1", "event_2"]);
      expect(reconciliation.cursor).toBe("cursor_1");
      expect(result).toEqual({
        processed: 1,
        duplicate: 0,
        ignored: 1,
        cursor: "cursor_1",
      });
    }),
  );

  it.effect("uses rangeStart instead of stored cursor for explicit replay", () =>
    Effect.gen(function* () {
      const reconciliation = makeReconciliation();

      yield* Effect.provide(
        Effect.gen(function* () {
          const service = yield* IdentityReconciliation;
          return yield* service.replayWorkOSEvents({ rangeStart: "2026-01-01T00:00:00Z" });
        }),
        reconciliation.layer,
      );

      expect(reconciliation.listCalls[0]).toEqual({
        after: undefined,
        rangeStart: "2026-01-01T00:00:00Z",
        limit: 100,
        order: "asc",
      });
    }),
  );
});

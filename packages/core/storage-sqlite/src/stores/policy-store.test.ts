import { Effect } from "effect";
import { createPolicyStoreContract } from "@executor/storage/testing";
import { createInMemorySqliteDb } from "../testing/in-memory-db";
import { makeSqlitePolicyStore } from "./policy-store";

createPolicyStoreContract("sqlite", {
  makeStore: () =>
    Effect.gen(function* () {
      const { db, close } = yield* createInMemorySqliteDb();
      return {
        store: makeSqlitePolicyStore(db),
        teardown: Effect.sync(() => close()),
      };
    }),
});

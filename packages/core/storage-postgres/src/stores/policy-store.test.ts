import { Effect } from "effect";
import { createPolicyStoreContract } from "@executor/sdk/testing";
import { createPgliteDb } from "../testing/pglite";
import { makePostgresPolicyStore } from "./policy-store";

createPolicyStoreContract("postgres", {
  makeStore: () =>
    Effect.gen(function* () {
      const { db, close } = yield* createPgliteDb();
      return {
        store: makePostgresPolicyStore(db),
        teardown: Effect.promise(() => close()),
      };
    }),
});

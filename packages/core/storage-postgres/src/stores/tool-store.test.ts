import { Effect } from "effect";
import { createToolStoreContract } from "@executor/sdk/testing";
import { createPgliteDb } from "../testing/pglite";
import { makePostgresToolStore } from "./tool-store";

createToolStoreContract("postgres", {
  makeStore: () =>
    Effect.gen(function* () {
      const { db, close } = yield* createPgliteDb();
      return {
        store: makePostgresToolStore(db),
        teardown: Effect.promise(() => close()),
      };
    }),
});

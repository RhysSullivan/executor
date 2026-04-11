import { Effect } from "effect";
import { createPluginKvStoreContract } from "@executor/sdk/testing";
import { createPgliteDb } from "../testing/pglite";
import { makePostgresPluginKvStore } from "./plugin-kv-store";

createPluginKvStoreContract("postgres", {
  makeStore: () =>
    Effect.gen(function* () {
      const { db, close } = yield* createPgliteDb();
      return {
        store: makePostgresPluginKvStore(db),
        teardown: Effect.promise(() => close()),
      };
    }),
});

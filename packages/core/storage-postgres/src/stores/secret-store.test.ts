import { Effect } from "effect";
import { createSecretStoreContract } from "@executor/sdk/testing";
import { createPgliteDb } from "../testing/pglite";
import { makePostgresSecretStore } from "./secret-store";

createSecretStoreContract("postgres", {
  makeStore: () =>
    Effect.gen(function* () {
      const { db, close } = yield* createPgliteDb();
      return {
        store: makePostgresSecretStore(db),
        teardown: Effect.promise(() => close()),
      };
    }),
});

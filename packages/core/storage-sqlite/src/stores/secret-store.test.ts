import { Effect } from "effect";
import { createSecretStoreContract } from "@executor/storage/testing";
import { createInMemorySqliteDb } from "../testing/in-memory-db";
import { makeSqliteSecretStore } from "./secret-store";

createSecretStoreContract("sqlite", {
  makeStore: () =>
    Effect.gen(function* () {
      const { db, close } = yield* createInMemorySqliteDb();
      return {
        store: makeSqliteSecretStore(db),
        teardown: Effect.sync(() => close()),
      };
    }),
});

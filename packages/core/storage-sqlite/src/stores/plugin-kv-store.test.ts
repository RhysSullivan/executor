import { Effect } from "effect";
import { createPluginKvStoreContract } from "@executor/storage/testing";
import { createInMemorySqliteDb } from "../testing/in-memory-db";
import { makeSqlitePluginKvStore } from "./plugin-kv-store";

createPluginKvStoreContract("sqlite", {
  makeStore: () =>
    Effect.gen(function* () {
      const { db, close } = yield* createInMemorySqliteDb();
      return {
        store: makeSqlitePluginKvStore(db),
        teardown: Effect.sync(() => close()),
      };
    }),
});

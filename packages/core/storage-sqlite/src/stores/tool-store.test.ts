import { Effect } from "effect";
import { createToolStoreContract } from "@executor/sdk/testing";
import { createInMemorySqliteDb } from "../testing/in-memory-db";
import { makeSqliteToolStore } from "./tool-store";

createToolStoreContract("sqlite", {
  makeStore: () =>
    Effect.gen(function* () {
      const { db, close } = yield* createInMemorySqliteDb();
      return {
        store: makeSqliteToolStore(db),
        teardown: Effect.sync(() => close()),
      };
    }),
});

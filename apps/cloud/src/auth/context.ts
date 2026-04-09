import { Context, Effect, Layer } from "effect";
import { makeUserStore } from "../services/user-store";
import { DbService } from "../services/db";
import { UserStoreError, withServiceLogging } from "./errors";

// AuthContext is defined in ./middleware.ts to keep middleware-related types together.
export { AuthContext } from "./middleware";

// ---------------------------------------------------------------------------
// UserStoreService — wraps the Drizzle-backed user store with Effect
// ---------------------------------------------------------------------------

type RawStore = ReturnType<typeof makeUserStore>;

const makeService = (store: RawStore) => ({
  use: <A>(fn: (s: RawStore) => Promise<A>) =>
    withServiceLogging(
      "user_store",
      () => new UserStoreError(),
      Effect.tryPromise({ try: () => fn(store), catch: (e) => e }),
    ),
});

type UserStoreServiceType = ReturnType<typeof makeService>;

export class UserStoreService extends Context.Tag("@executor/cloud/UserStoreService")<
  UserStoreService,
  UserStoreServiceType
>() {
  static Live = Layer.effect(
    this,
    Effect.map(DbService, (db) => makeService(makeUserStore(db))),
  );
}

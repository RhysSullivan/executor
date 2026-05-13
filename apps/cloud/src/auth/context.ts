import { Context, Effect, Layer } from "effect";
import { makeUserStore } from "../services/user-store";
import { DbService } from "../services/db";
import { UserStoreError, tryPromiseService, withServiceLogging } from "./errors";

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
      tryPromiseService(() => fn(store)),
    ),
});

type UserStoreServiceType = ReturnType<typeof makeService>;

export class UserStoreService extends Context.Service<UserStoreService, UserStoreServiceType>()(
  "@executor-js/cloud/UserStoreService",
) {
  static Live = Layer.effect(this)(
    Effect.map(DbService.asEffect(), ({ db }) => makeService(makeUserStore(db))),
  );
}

import { Context, Effect, Layer } from "effect";
import { makeUserStore } from "../services/user-store";
import { DbService } from "../services/db";
import { UserStoreError } from "./errors";

// AuthContext is defined in ./middleware.ts to keep middleware-related types together.
export { AuthContext } from "./middleware";

// ---------------------------------------------------------------------------
// UserStoreService — wraps the Drizzle-backed user store with Effect
// ---------------------------------------------------------------------------

type RawStore = ReturnType<typeof makeUserStore>;

const makeService = (store: RawStore) => {
  const use = <A>(fn: (s: RawStore) => Promise<A>) =>
    Effect.tryPromise({
      try: () => fn(store),
      catch: (cause) => cause,
    }).pipe(
      Effect.tapError((cause) =>
        Effect.sync(() => {
          // eslint-disable-next-line no-console
          console.error("[user_store] query failed:", cause);
        }),
      ),
      Effect.mapError(() => new UserStoreError()),
      Effect.withSpan("user_store"),
    );

  return { use };
};

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

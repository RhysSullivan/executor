import { Context, Effect, Layer } from "effect";
import { makeUserStore } from "../services/user-store";
import { DbService } from "../services/db";
import { UserStoreError } from "./errors";

// ---------------------------------------------------------------------------
// AuthContext — resolved per-request from sealed session
// ---------------------------------------------------------------------------

export class AuthContext extends Context.Tag("@executor/cloud/AuthContext")<
  AuthContext,
  {
    readonly userId: string;
    readonly teamId: string;
    readonly email: string;
    readonly name: string | null;
    readonly avatarUrl: string | null;
  }
>() {}

// ---------------------------------------------------------------------------
// UserStoreService — wraps the Drizzle-backed user store with Effect
// ---------------------------------------------------------------------------

type RawStore = ReturnType<typeof makeUserStore>;

const makeService = (store: RawStore) => {
  const use = <A>(fn: (s: RawStore) => Promise<A>) =>
    Effect.tryPromise({
      try: () => fn(store),
      catch: (cause) => new UserStoreError({ cause }),
    }).pipe(Effect.withSpan("user_store"));

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

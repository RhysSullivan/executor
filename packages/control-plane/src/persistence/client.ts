import * as Effect from "effect/Effect";

import {
  type ControlPlanePersistenceError,
  toPersistenceError,
} from "./persistence-errors";
import type { DrizzleDb, SqlBackend } from "./sql-runtime";

export type DrizzleSession = Pick<DrizzleDb, "select" | "insert" | "update" | "delete">;

export type DrizzleClient = {
  backend: SqlBackend;
  db: DrizzleDb;
  use: <A>(
    operation: string,
    run: (db: DrizzleSession) => Promise<A>,
  ) => Effect.Effect<A, ControlPlanePersistenceError>;
  useTx: <A>(
    operation: string,
    run: (tx: DrizzleSession) => Promise<A>,
  ) => Effect.Effect<A, ControlPlanePersistenceError>;
};

const createSerializer = (backend: SqlBackend) => {
  let queue = Promise.resolve<void>(undefined);

  return <A>(run: () => Promise<A>): Promise<A> => {
    if (backend !== "pglite") {
      return run();
    }

    const next: Promise<A> = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
};

export const createDrizzleClient = (input: {
  backend: SqlBackend;
  db: DrizzleDb;
}): DrizzleClient => {
  const serialize = createSerializer(input.backend);

  const use = <A>(
    operation: string,
    run: (db: DrizzleSession) => Promise<A>,
  ): Effect.Effect<A, ControlPlanePersistenceError> =>
    Effect.tryPromise({
      try: () => serialize(() => run(input.db)),
      catch: (cause) => toPersistenceError(operation, cause),
    });

  const useTx = <A>(
    operation: string,
    run: (tx: DrizzleSession) => Promise<A>,
  ): Effect.Effect<A, ControlPlanePersistenceError> =>
    use(operation, () =>
      input.db.transaction(async (tx) => run(tx as unknown as DrizzleSession)),
    );

  return {
    backend: input.backend,
    db: input.db,
    use,
    useTx,
  };
};

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { toRowStoreError } from "./persistence-errors";
import { createRowOperations } from "./row-operations";
import { type SqlBackend } from "./sql-internals";

export type RowOperations = ReturnType<typeof createRowOperations>;

export const toListEffect = <A>(
  backend: SqlBackend,
  operation: string,
  location: string,
  run: () => Promise<ReadonlyArray<A>>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => toRowStoreError(backend, operation, location, cause),
  });

export const toVoidEffect = (
  backend: SqlBackend,
  operation: string,
  location: string,
  run: () => Promise<void>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => toRowStoreError(backend, operation, location, cause),
  });

export const toBooleanEffect = (
  backend: SqlBackend,
  operation: string,
  location: string,
  run: () => Promise<boolean>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => toRowStoreError(backend, operation, location, cause),
  });

export const toOptionEffect = <A>(
  backend: SqlBackend,
  operation: string,
  location: string,
  run: () => Promise<A | null>,
) =>
  Effect.tryPromise({
    try: async () => {
      const value = await run();
      return value === null ? Option.none<A>() : Option.some(value);
    },
    catch: (cause) => toRowStoreError(backend, operation, location, cause),
  });

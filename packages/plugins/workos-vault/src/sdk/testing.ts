// In-memory test double for `WorkOSVaultClient`.
//
// Mirrors the Effect-shaped surface of the real client (see ./client.ts) but
// stores objects in a `Map<string, WorkOSVaultObject>` keyed by name so tests
// never hit WorkOS. Errors carry a numeric `status` on `cause` so the
// production `isStatusError` checks in `secret-store.ts` match the same
// 404/409/400 paths the real SDK exercises.

import { Data, Effect } from "effect";

import {
  WorkOSVaultClientError,
  type WorkOSVaultClient,
  type WorkOSVaultObject,
  type WorkOSVaultObjectMetadata,
  type WorkOSVaultPromiseApi,
} from "./client";

export class TestWorkOSVaultNotFoundError extends Data.TaggedError(
  "TestWorkOSVaultNotFoundError",
)<{
  readonly message: string;
  readonly status: 404;
}> {}

export class TestWorkOSVaultConflictError extends Data.TaggedError(
  "TestWorkOSVaultConflictError",
)<{
  readonly message: string;
  readonly status: 409;
}> {}

export class TestWorkOSVaultInvalidRequestError extends Data.TaggedError(
  "TestWorkOSVaultInvalidRequestError",
)<{
  readonly message: string;
  readonly status: 400;
}> {}

type TestWorkOSVaultError =
  | TestWorkOSVaultNotFoundError
  | TestWorkOSVaultConflictError
  | TestWorkOSVaultInvalidRequestError;

export interface TestWorkOSVaultClientOptions {
  /**
   * Injects a single 409 on the next update against an object whose name
   * ends in `/secrets/conflict`. The retry path in the secret store should
   * then re-read and succeed on the second attempt.
   */
  readonly conflictOnNextSecretUpdate?: boolean;
  /**
   * Reject create/read with a 400 when the name contains a colon. Useful
   * for exercising the secret store's invalid-name fallback paths.
   */
  readonly rejectNamesWithColon?: boolean;
  /**
   * Reject reads with a 400 when the requested name is longer than this
   * threshold. Mirrors WorkOS's own length cap on object names.
   */
  readonly rejectReadNamesLongerThan?: number;
}

const notFound = (message: string) =>
  new TestWorkOSVaultNotFoundError({ message, status: 404 });

const conflict = (message: string) =>
  new TestWorkOSVaultConflictError({ message, status: 409 });

const invalidRequest = (message: string) =>
  new TestWorkOSVaultInvalidRequestError({ message, status: 400 });

const makeMetadata = (
  id: string,
  context: Record<string, string>,
  versionId: string,
): WorkOSVaultObjectMetadata => ({
  id,
  context,
  updatedAt: new Date(),
  versionId,
});

export const makeTestWorkOSVaultClient = (
  options?: TestWorkOSVaultClientOptions,
): WorkOSVaultClient => {
  const objects = new Map<string, WorkOSVaultObject>();
  let sequence = 0;
  let conflictPending = options?.conflictOnNextSecretUpdate ?? false;

  const nextId = () =>
    `vault_${(sequence += 1)}_${crypto.randomUUID().slice(0, 8)}`;

  const validateObjectName = (
    name: string,
  ): Effect.Effect<void, TestWorkOSVaultError> => {
    if (options?.rejectNamesWithColon && name.includes(":")) {
      return Effect.fail(invalidRequest(`Invalid object name "${name}"`));
    }
    return Effect.void;
  };

  const validateReadName = (
    name: string,
  ): Effect.Effect<void, TestWorkOSVaultError> =>
    Effect.gen(function* () {
      yield* validateObjectName(name);
      if (
        options?.rejectReadNamesLongerThan !== undefined &&
        name.length > options.rejectReadNamesLongerThan
      ) {
        return yield* invalidRequest(`Invalid object name "${name}"`);
      }
    });

  const createObject = (opts: {
    readonly name: string;
    readonly value: string;
    readonly context: Record<string, string>;
  }): Effect.Effect<WorkOSVaultObjectMetadata, TestWorkOSVaultError> =>
    Effect.gen(function* () {
      yield* validateObjectName(opts.name);
      if (objects.has(opts.name)) {
        return yield* conflict(`Object "${opts.name}" already exists`);
      }
      const id = nextId();
      const metadata = makeMetadata(id, opts.context, `${id}-v1`);
      objects.set(opts.name, {
        id,
        name: opts.name,
        value: opts.value,
        metadata,
      });
      return metadata;
    });

  const readObjectByName = (
    name: string,
  ): Effect.Effect<WorkOSVaultObject, TestWorkOSVaultError> =>
    Effect.gen(function* () {
      yield* validateReadName(name);
      const object = objects.get(name);
      if (!object) {
        return yield* notFound(`Object "${name}" not found`);
      }
      return object;
    });

  const updateObject = (opts: {
    readonly id: string;
    readonly value: string;
    readonly versionCheck?: string;
  }): Effect.Effect<WorkOSVaultObject, TestWorkOSVaultError> =>
    Effect.gen(function* () {
      const current = [...objects.values()].find((o) => o.id === opts.id);
      if (!current) {
        return yield* notFound(`Object "${opts.id}" not found`);
      }
      if (conflictPending && current.name.endsWith("/secrets/conflict")) {
        conflictPending = false;
        return yield* conflict(`Injected conflict for "${opts.id}"`);
      }
      if (
        opts.versionCheck &&
        current.metadata.versionId !== opts.versionCheck
      ) {
        return yield* conflict(`Version mismatch for "${opts.id}"`);
      }

      const nextVersion = current.metadata.versionId.replace(
        /v(\d+)$/,
        (_, version) => `v${Number(version) + 1}`,
      );
      const next: WorkOSVaultObject = {
        ...current,
        value: opts.value,
        metadata: {
          ...current.metadata,
          updatedAt: new Date(),
          versionId: nextVersion,
        },
      };
      objects.set(current.name, next);
      return next;
    });

  const deleteObject = (opts: {
    readonly id: string;
  }): Effect.Effect<void, TestWorkOSVaultError> =>
    Effect.gen(function* () {
      const entry = [...objects.entries()].find(
        ([, object]) => object.id === opts.id,
      );
      if (!entry) {
        return yield* notFound(`Object "${opts.id}" not found`);
      }
      objects.delete(entry[0]);
    });

  const wrap = <A>(
    operation: string,
    effect: Effect.Effect<A, TestWorkOSVaultError>,
  ): Effect.Effect<A, WorkOSVaultClientError> =>
    effect.pipe(
      Effect.mapError((cause) => new WorkOSVaultClientError({ cause, operation })),
      Effect.withSpan(`workos_vault.test.${operation}`),
    );

  // Promise-shaped facade exposed to `use` callers, which may be plugin code
  // that still calls into the underlying SDK directly via `client.use(...)`.
  // Each method runs the in-memory effect and rethrows the tagged error so
  // callers see the same `.status` shape they would from a real SDK rejection.
  const rawClient: WorkOSVaultPromiseApi = {
    createObject: (opts) => Effect.runPromise(createObject(opts)),
    readObjectByName: (name) => Effect.runPromise(readObjectByName(name)),
    updateObject: (opts) => Effect.runPromise(updateObject(opts)),
    deleteObject: (opts) => Effect.runPromise(deleteObject(opts)),
  };

  return {
    use: (operation, fn) =>
      Effect.tryPromise({
        try: () => fn(rawClient),
        catch: (cause) => new WorkOSVaultClientError({ cause, operation }),
      }).pipe(Effect.withSpan(`workos_vault.test.${operation}`)),
    createObject: (opts) => wrap("create_object", createObject(opts)),
    readObjectByName: (name) => wrap("read_object_by_name", readObjectByName(name)),
    updateObject: (opts) => wrap("update_object", updateObject(opts)),
    deleteObject: (opts) => wrap("delete_object", deleteObject(opts)),
  };
};

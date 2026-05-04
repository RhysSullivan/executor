import type { WorkOS } from "@workos-inc/node/worker";
import {
  GenericServerException,
  NotFoundException,
  WorkOS as WorkOSClient,
} from "@workos-inc/node/worker";
import { Data, Effect, Result } from "effect";

export interface WorkOSVaultObjectMetadata {
  readonly context: Record<string, unknown>;
  readonly id: string;
  readonly updatedAt: Date;
  readonly versionId: string;
}

export interface WorkOSVaultObject {
  readonly id: string;
  readonly metadata: WorkOSVaultObjectMetadata;
  readonly name: string;
  readonly value?: string;
}

// Minimal shape carrying an HTTP-style status code. Production WorkOS errors
// (`GenericServerException`/`NotFoundException`) and test fakes both populate
// a numeric `status`, so the boundary normalises against this named type
// rather than probing arbitrary unknown shapes.
interface ErrorWithStatus extends Error {
  readonly status: number;
}

const isErrorWithStatus = (cause: unknown): cause is ErrorWithStatus =>
  cause instanceof Error && typeof (cause as ErrorWithStatus).status === "number";

const statusFromWorkOSCause = (cause: unknown): number | undefined => {
  if (cause instanceof GenericServerException || cause instanceof NotFoundException) {
    return cause.status;
  }
  if (isErrorWithStatus(cause)) return cause.status;
  return undefined;
};

const messageFromWorkOSCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";

export class WorkOSVaultClientError extends Data.TaggedError("WorkOSVaultClientError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly operation: string;
  readonly status?: number;
}> {
  constructor(options: {
    readonly cause: unknown;
    readonly message?: string;
    readonly operation: string;
    readonly status?: number;
  }) {
    super({
      cause: options.cause,
      message: options.message ?? messageFromWorkOSCause(options.cause),
      operation: options.operation,
      status: options.status ?? statusFromWorkOSCause(options.cause),
    });
  }
}

export class WorkOSVaultClientInstantiationError extends Data.TaggedError(
  "WorkOSVaultClientInstantiationError",
)<{
  readonly cause: unknown;
}> {}

// Promise-shaped facade onto the underlying WorkOS SDK. Module-private — the
// public surface in `WorkOSVaultClient` is Effect-only. Test doubles import
// this type to stand up an in-memory equivalent.
export interface WorkOSVaultPromiseApi {
  readonly createObject: (options: {
    readonly name: string;
    readonly value: string;
    readonly context: Record<string, string>;
  }) => Promise<WorkOSVaultObjectMetadata>;
  readonly readObjectByName: (name: string) => Promise<WorkOSVaultObject>;
  readonly updateObject: (options: {
    readonly id: string;
    readonly value: string;
    readonly versionCheck?: string;
  }) => Promise<WorkOSVaultObject>;
  readonly deleteObject: (options: { readonly id: string }) => Promise<void>;
}

export interface WorkOSVaultCredentials {
  readonly apiKey: string;
  readonly clientId: string;
}

interface WorkOSVaultUseOptions {
  readonly expectedErrorStatuses?: readonly number[];
  readonly expectedErrorOutcome?: string;
}

export interface WorkOSVaultClient {
  readonly use: <A>(
    operation: string,
    fn: (client: WorkOSVaultPromiseApi) => Promise<A>,
    options?: WorkOSVaultUseOptions,
  ) => Effect.Effect<A, WorkOSVaultClientError, never>;
  readonly createObject: (options: {
    readonly name: string;
    readonly value: string;
    readonly context: Record<string, string>;
  }) => Effect.Effect<WorkOSVaultObjectMetadata, WorkOSVaultClientError, never>;
  readonly readObjectByName: (
    name: string,
  ) => Effect.Effect<WorkOSVaultObject, WorkOSVaultClientError, never>;
  readonly updateObject: (options: {
    readonly id: string;
    readonly value: string;
    readonly versionCheck?: string;
  }) => Effect.Effect<WorkOSVaultObject, WorkOSVaultClientError, never>;
  readonly deleteObject: (options: {
    readonly id: string;
  }) => Effect.Effect<void, WorkOSVaultClientError, never>;
}

const isExpectedVaultError = (
  error: WorkOSVaultClientError,
  options: WorkOSVaultUseOptions | undefined,
): boolean => {
  if (error.status === undefined) return false;
  return options?.expectedErrorStatuses?.includes(error.status) ?? false;
};

export const makeWorkOSVaultClient = (workos: Pick<WorkOS, "vault">): WorkOSVaultClient => {
  const client: WorkOSVaultPromiseApi = workos.vault;

  const use = <A>(
    operation: string,
    fn: (vault: WorkOSVaultPromiseApi) => Promise<A>,
    options?: WorkOSVaultUseOptions,
  ): Effect.Effect<A, WorkOSVaultClientError, never> => {
    const attempt = Effect.tryPromise({
      try: () => fn(client),
      catch: (cause) => new WorkOSVaultClientError({ cause, operation }),
    });

    const observed = attempt.pipe(
      Effect.result,
      Effect.flatMap((outcome) =>
        Effect.gen(function* () {
          if (Result.isSuccess(outcome)) {
            yield* Effect.annotateCurrentSpan({ "workos_vault.outcome": "ok" });
            return outcome;
          }

          const status = outcome.failure.status;
          if (isExpectedVaultError(outcome.failure, options)) {
            yield* Effect.annotateCurrentSpan({
              "workos_vault.outcome": options?.expectedErrorOutcome ?? "expected_error",
              "workos_vault.status": status ?? "unknown",
            });
            return outcome;
          }

          yield* Effect.annotateCurrentSpan({
            "workos_vault.outcome": "error",
            "workos_vault.status": status ?? "unknown",
          });
          return yield* Effect.fail(outcome.failure);
        }),
      ),
      Effect.withSpan(`workos_vault.${operation}`),
    );

    return observed.pipe(
      Effect.flatMap((outcome) =>
        Result.isSuccess(outcome) ? Effect.succeed(outcome.success) : Effect.fail(outcome.failure),
      ),
    );
  };

  return {
    use,
    createObject: (options) => use("create_object", (vault) => vault.createObject(options)),
    readObjectByName: (name) =>
      use("read_object_by_name", (vault) => vault.readObjectByName(name), {
        expectedErrorOutcome: "expected_missing_object",
        expectedErrorStatuses: [400, 404],
      }),
    updateObject: (options) => use("update_object", (vault) => vault.updateObject(options)),
    deleteObject: (options) => use("delete_object", (vault) => vault.deleteObject(options)),
  };
};

export const makeConfiguredWorkOSVaultClient = (
  credentials: WorkOSVaultCredentials,
): Effect.Effect<WorkOSVaultClient, WorkOSVaultClientInstantiationError, never> =>
  Effect.try({
    try: () =>
      makeWorkOSVaultClient(
        new WorkOSClient({
          apiKey: credentials.apiKey,
          clientId: credentials.clientId,
        }),
      ),
    catch: (cause) => new WorkOSVaultClientInstantiationError({ cause }),
  }).pipe(Effect.withSpan("workos_vault.make_client"));

import type { WorkOS } from "@workos-inc/node/worker";
import { WorkOS as WorkOSClient } from "@workos-inc/node/worker";
import { Data, Effect, Either } from "effect";

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

export class WorkOSVaultClientError extends Data.TaggedError("WorkOSVaultClientError")<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

export class WorkOSVaultClientInstantiationError extends Data.TaggedError(
  "WorkOSVaultClientInstantiationError",
)<{
  readonly cause: unknown;
}> {}

export interface WorkOSVaultSdk {
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
    fn: (client: WorkOSVaultSdk) => Promise<A>,
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

const vaultErrorStatus = (error: WorkOSVaultClientError): number | null => {
  const cause = error.cause;
  return typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    typeof (cause as { readonly status: unknown }).status === "number"
    ? (cause as { readonly status: number }).status
    : null;
};

const isExpectedVaultError = (
  error: WorkOSVaultClientError,
  options: WorkOSVaultUseOptions | undefined,
): boolean => {
  const status = vaultErrorStatus(error);
  return status !== null && (options?.expectedErrorStatuses?.includes(status) ?? false);
};

export const makeWorkOSVaultClient = (workos: Pick<WorkOS, "vault">): WorkOSVaultClient => {
  const client: WorkOSVaultSdk = workos.vault;

  const use = <A>(
    operation: string,
    fn: (vault: WorkOSVaultSdk) => Promise<A>,
    options?: WorkOSVaultUseOptions,
  ): Effect.Effect<A, WorkOSVaultClientError, never> => {
    const attempt = Effect.tryPromise({
      try: () => fn(client),
      catch: (cause) => new WorkOSVaultClientError({ cause, operation }),
    });

    const observed = attempt.pipe(
      Effect.either,
      Effect.flatMap((outcome) =>
        Effect.gen(function* () {
          if (Either.isRight(outcome)) {
            yield* Effect.annotateCurrentSpan({ "workos_vault.outcome": "ok" });
            return outcome;
          }

          const status = vaultErrorStatus(outcome.left);
          if (isExpectedVaultError(outcome.left, options)) {
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
          return yield* Effect.fail(outcome.left);
        }),
      ),
      Effect.withSpan(`workos_vault.${operation}`),
    );

    return observed.pipe(
      Effect.flatMap((outcome) =>
        Either.isRight(outcome) ? Effect.succeed(outcome.right) : Effect.fail(outcome.left),
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

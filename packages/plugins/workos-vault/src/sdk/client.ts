import type { WorkOS } from "@workos-inc/node/worker";
import { WorkOS as WorkOSClient } from "@workos-inc/node/worker";
import { Data, Effect } from "effect";

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

export interface WorkOSVaultClient {
  readonly use: <A>(
    operation: string,
    fn: (client: WorkOSVaultSdk) => Promise<A>,
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

export const makeWorkOSVaultClient = (
  workos: Pick<WorkOS, "vault">,
): WorkOSVaultClient => {
  const client: WorkOSVaultSdk = workos.vault;

  const use = <A>(
    operation: string,
    fn: (vault: WorkOSVaultSdk) => Promise<A>,
  ): Effect.Effect<A, WorkOSVaultClientError, never> =>
    Effect.tryPromise({
      try: () => fn(client),
      catch: (cause) => new WorkOSVaultClientError({ cause, operation }),
    }).pipe(Effect.withSpan(`workos_vault.${operation}`));

  return {
    use,
    createObject: (options) => use("create_object", (vault) => vault.createObject(options)),
    readObjectByName: (name) => use("read_object_by_name", (vault) => vault.readObjectByName(name)),
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

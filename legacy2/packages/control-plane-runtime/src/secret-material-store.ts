import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { type SqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import {
  type AccountId,
  type AuthConnectionId,
  type OrganizationId,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export type SecretMaterialPurpose =
  | "auth_material"
  | "oauth_access_token"
  | "oauth_refresh_token"
  | "oauth_client_secret";

export type SecretMaterialScope = {
  organizationId: OrganizationId;
  workspaceId: WorkspaceId | null;
  accountId: AccountId | null;
  connectionId: AuthConnectionId;
  purpose: SecretMaterialPurpose;
};

export class SecretMaterialStoreError extends Data.TaggedError(
  "SecretMaterialStoreError",
)<{
  operation: string;
  message: string;
  details: string | null;
}> {}

export type SecretMaterialStore = {
  kind: string;
  put: (input: {
    value: string;
    scope: SecretMaterialScope;
  }) => Effect.Effect<string, SecretMaterialStoreError>;
  get: (input: {
    handle: string;
    scope: SecretMaterialScope;
  }) => Effect.Effect<string, SecretMaterialStoreError>;
  remove: (input: {
    handle: string;
    scope: SecretMaterialScope;
  }) => Effect.Effect<void, SecretMaterialStoreError>;
};

type SqlSecretMaterialRows = Pick<
  SqlControlPlanePersistence["rows"]["secretMaterials"],
  "getByHandle" | "upsert" | "removeByHandle"
>;

const keychainServiceName = "executor-v2";

const toStoreError = (
  operation: string,
  message: string,
  details: string | null,
): SecretMaterialStoreError =>
  new SecretMaterialStoreError({
    operation,
    message,
    details,
  });

const trim = (value: string): string => value.trim();

type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const runCommand = (input: {
  command: string;
  args: ReadonlyArray<string>;
  stdin?: string;
  operation: string;
}): Effect.Effect<SpawnResult, SecretMaterialStoreError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<SpawnResult>((resolve, reject) => {
        const child = spawn(input.command, [...input.args], {
          stdio: "pipe",
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString("utf8");
        });

        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });

        child.on("error", (error) => {
          reject(
            toStoreError(
              input.operation,
              `Failed spawning '${input.command}'`,
              error.message,
            ),
          );
        });

        child.on("close", (code) => {
          const exitCode = code ?? 0;
          resolve({
            exitCode,
            stdout,
            stderr,
          });
        });

        if (input.stdin !== undefined) {
          child.stdin.write(input.stdin);
        }

        child.stdin.end();
      }),
    catch: (cause) =>
      cause instanceof SecretMaterialStoreError
        ? cause
        : toStoreError(
            input.operation,
            `Command execution failed for '${input.command}'`,
            cause instanceof Error ? cause.message : String(cause),
          ),
  });

const ensureSuccess = (
  result: SpawnResult,
  operation: string,
  message: string,
): Effect.Effect<SpawnResult, SecretMaterialStoreError> => {
  if (result.exitCode === 0) {
    return Effect.succeed(result);
  }

  return Effect.fail(
    toStoreError(operation, message, trim(result.stderr) || trim(result.stdout) || null),
  );
};

const parseKeychainHandle = (handle: string): string | null => {
  if (!handle.startsWith("keychain:")) {
    return null;
  }

  const id = handle.slice("keychain:".length).trim();
  return id.length > 0 ? id : null;
};

const parseSqlHandle = (handle: string): string | null => {
  if (!handle.startsWith("sql:")) {
    return null;
  }

  const id = handle.slice("sql:".length).trim();
  return id.length > 0 ? id : null;
};

const keychainStoreWithSecurityCli = (): SecretMaterialStore => {
  const put = ({ value }: { value: string; scope: SecretMaterialScope }) => {
    const id = randomUUID();
    const handle = `keychain:${id}`;

    return runCommand({
      command: "security",
      args: [
        "add-generic-password",
        "-a",
        id,
        "-s",
        keychainServiceName,
        "-w",
        value,
        "-U",
      ],
      operation: "keychain.put",
    }).pipe(
      Effect.flatMap((result) =>
        ensureSuccess(result, "keychain.put", "Failed storing secret in macOS keychain"),
      ),
      Effect.as(handle),
    );
  };

  const get = ({ handle }: { handle: string; scope: SecretMaterialScope }) => {
    const id = parseKeychainHandle(handle);
    if (!id) {
      return Effect.fail(
        toStoreError("keychain.get", "Invalid keychain secret handle", handle),
      );
    }

    return runCommand({
      command: "security",
      args: [
        "find-generic-password",
        "-a",
        id,
        "-s",
        keychainServiceName,
        "-w",
      ],
      operation: "keychain.get",
    }).pipe(
      Effect.flatMap((result) =>
        ensureSuccess(result, "keychain.get", "Failed loading secret from macOS keychain"),
      ),
      Effect.map((result) => result.stdout.trimEnd()),
    );
  };

  const remove = ({ handle }: { handle: string; scope: SecretMaterialScope }) => {
    const id = parseKeychainHandle(handle);
    if (!id) {
      return Effect.void;
    }

    return runCommand({
      command: "security",
      args: [
        "delete-generic-password",
        "-a",
        id,
        "-s",
        keychainServiceName,
      ],
      operation: "keychain.remove",
    }).pipe(
      Effect.flatMap((result) =>
        ensureSuccess(result, "keychain.remove", "Failed removing secret from macOS keychain"),
      ),
      Effect.asVoid,
    );
  };

  return {
    kind: "keychain",
    put,
    get,
    remove,
  };
};

const keychainStoreWithSecretTool = (): SecretMaterialStore => {
  const put = ({ value }: { value: string; scope: SecretMaterialScope }) => {
    const id = randomUUID();
    const handle = `keychain:${id}`;

    return runCommand({
      command: "secret-tool",
      args: [
        "store",
        "--label",
        "executor-v2",
        "service",
        keychainServiceName,
        "account",
        id,
      ],
      stdin: value,
      operation: "keychain.put",
    }).pipe(
      Effect.flatMap((result) =>
        ensureSuccess(result, "keychain.put", "Failed storing secret in desktop keyring"),
      ),
      Effect.as(handle),
    );
  };

  const get = ({ handle }: { handle: string; scope: SecretMaterialScope }) => {
    const id = parseKeychainHandle(handle);
    if (!id) {
      return Effect.fail(
        toStoreError("keychain.get", "Invalid keychain secret handle", handle),
      );
    }

    return runCommand({
      command: "secret-tool",
      args: [
        "lookup",
        "service",
        keychainServiceName,
        "account",
        id,
      ],
      operation: "keychain.get",
    }).pipe(
      Effect.flatMap((result) =>
        ensureSuccess(result, "keychain.get", "Failed loading secret from desktop keyring"),
      ),
      Effect.map((result) => result.stdout.trimEnd()),
    );
  };

  const remove = ({ handle }: { handle: string; scope: SecretMaterialScope }) => {
    const id = parseKeychainHandle(handle);
    if (!id) {
      return Effect.void;
    }

    return runCommand({
      command: "secret-tool",
      args: [
        "clear",
        "service",
        keychainServiceName,
        "account",
        id,
      ],
      operation: "keychain.remove",
    }).pipe(
      Effect.flatMap((result) =>
        ensureSuccess(result, "keychain.remove", "Failed removing secret from desktop keyring"),
      ),
      Effect.asVoid,
    );
  };

  return {
    kind: "keychain",
    put,
    get,
    remove,
  };
};

export const createKeychainSecretMaterialStore = (): SecretMaterialStore => {
  if (process.platform === "darwin") {
    return keychainStoreWithSecurityCli();
  }

  if (process.platform === "linux") {
    return keychainStoreWithSecretTool();
  }

  return {
    kind: "keychain",
    put: () =>
      Effect.fail(
        toStoreError(
          "keychain.put",
          `Keychain backend is unsupported on platform '${process.platform}'`,
          null,
        ),
      ),
    get: () =>
      Effect.fail(
        toStoreError(
          "keychain.get",
          `Keychain backend is unsupported on platform '${process.platform}'`,
          null,
        ),
      ),
    remove: () => Effect.void,
  };
};

export const createSqlSecretMaterialStore = (
  rows: SqlSecretMaterialRows,
): SecretMaterialStore => ({
  kind: "sql",

  put: ({ value, scope }) =>
    Effect.gen(function* () {
      const id = randomUUID();
      const handle = `sql:${id}`;
      const now = Date.now();

      yield* rows.upsert({
        handle,
        backend: "sql",
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        accountId: scope.accountId,
        connectionId: scope.connectionId,
        purpose: scope.purpose,
        material: value,
        createdAt: now,
        updatedAt: now,
      }).pipe(
        Effect.mapError((error) =>
          toStoreError(
            "sql.put",
            "Failed storing secret in SQL backend",
            error.details ?? error.message,
          ),
        ),
      );

      return handle;
    }),

  get: ({ handle }) =>
    Effect.gen(function* () {
      const normalized = parseSqlHandle(handle);
      if (!normalized) {
        return yield* toStoreError("sql.get", "Invalid SQL secret handle", handle);
      }

      const materialOption = yield* rows.getByHandle(`sql:${normalized}`).pipe(
        Effect.mapError((error) =>
          toStoreError(
            "sql.get",
            "Failed loading secret from SQL backend",
            error.details ?? error.message,
          ),
        ),
      );

      const material = Option.getOrNull(materialOption);
      if (!material) {
        return yield* toStoreError(
          "sql.get",
          "Secret handle not found in SQL backend",
          handle,
        );
      }

      return material.material;
    }),

  remove: ({ handle }) =>
    Effect.gen(function* () {
      const normalized = parseSqlHandle(handle);
      if (!normalized) {
        return;
      }

      yield* rows.removeByHandle(`sql:${normalized}`).pipe(
        Effect.mapError((error) =>
          toStoreError(
            "sql.remove",
            "Failed removing secret from SQL backend",
            error.details ?? error.message,
          ),
        ),
      );
    }),
});

export type SecretMaterialBackendKind = "keychain" | "sql";

export const parseSecretMaterialBackendKind = (
  value: string | undefined,
): SecretMaterialBackendKind | null => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "keychain") {
    return "keychain";
  }

  if (normalized === "sql") {
    return "sql";
  }

  return null;
};

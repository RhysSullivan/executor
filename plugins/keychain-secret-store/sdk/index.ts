import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import * as Effect from "effect/Effect";

import {
  defineExecutorSecretStorePlugin,
} from "@executor/platform-sdk/plugins";
import {
  runtimeEffectError,
} from "@executor/platform-sdk/runtime";

export const KEYCHAIN_SECRET_STORE_KIND = "keychain";
export const KEYCHAIN_SECRET_STORE_ID = "sts_builtin_keychain";

const DEFAULT_KEYCHAIN_SERVICE_NAME = "executor";
const KEYCHAIN_COMMAND_TIMEOUT_MS = 5_000;
const KEYCHAIN_SERVICE_NAME_ENV = "EXECUTOR_KEYCHAIN_SERVICE_NAME";

type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const ensureNonEmptyString = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const resolveKeychainServiceName = (value: string | undefined): string =>
  trimOrNull(value)
  ?? trimOrNull(process.env[KEYCHAIN_SERVICE_NAME_ENV])
  ?? DEFAULT_KEYCHAIN_SERVICE_NAME;

const runCommand = (input: {
  command: string;
  args: ReadonlyArray<string>;
  stdin?: string;
  operation: string;
  timeoutMs?: number;
}): Effect.Effect<SpawnResult, Error, never> =>
  Effect.tryPromise({
    try: () =>
      new Promise<SpawnResult>((resolve, reject) => {
        const child = spawn(input.command, [...input.args], {
          stdio: "pipe",
          env: process.env,
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        const timeout = input.timeoutMs === undefined
          ? null
          : setTimeout(() => {
            if (settled) {
              return;
            }

            settled = true;
            child.kill("SIGKILL");
            reject(
              new Error(
                `${input.operation}: '${input.command}' timed out after ${input.timeoutMs}ms`,
              ),
            );
          }, input.timeoutMs);

        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString("utf8");
        });

        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });

        child.on("error", (error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeout) {
            clearTimeout(timeout);
          }
          reject(error);
        });

        child.on("close", (code) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeout) {
            clearTimeout(timeout);
          }
          resolve({
            exitCode: code ?? 0,
            stdout,
            stderr,
          });
        });

        if (input.stdin !== undefined) {
          child.stdin.write(input.stdin);
        }

        child.stdin.end();
      }),
    catch: toError,
  });

const ensureCommandSuccess = (input: {
  result: SpawnResult;
  operation: string;
  message: string;
}): Effect.Effect<SpawnResult, Error, never> => {
  if (input.result.exitCode === 0) {
    return Effect.succeed(input.result);
  }

  const details = ensureNonEmptyString(input.result.stderr)
    ?? ensureNonEmptyString(input.result.stdout)
    ?? "command returned non-zero exit code";

  return Effect.fail(
    runtimeEffectError(
      "plugin-keychain-secret-store",
      `${input.operation}: ${input.message}: ${details}`,
    ),
  );
};

const readKeychainSecretValue = (input: {
  providerHandle: string;
  keychainServiceName: string;
}) => {
  switch (process.platform) {
    case "darwin":
      return runCommand({
        command: "security",
        args: [
          "find-generic-password",
          "-a",
          input.providerHandle,
          "-s",
          input.keychainServiceName,
          "-w",
        ],
        operation: "keychain.get",
        timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS,
      }).pipe(
        Effect.flatMap((result) =>
          ensureCommandSuccess({
            result,
            operation: "keychain.get",
            message: "Failed loading secret from macOS keychain",
          })),
        Effect.map((result) => result.stdout.trimEnd()),
      );
    case "linux":
      return runCommand({
        command: "secret-tool",
        args: [
          "lookup",
          "service",
          input.keychainServiceName,
          "account",
          input.providerHandle,
        ],
        operation: "keychain.get",
        timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS,
      }).pipe(
        Effect.flatMap((result) =>
          ensureCommandSuccess({
            result,
            operation: "keychain.get",
            message: "Failed loading secret from desktop keyring",
          })),
        Effect.map((result) => result.stdout.trimEnd()),
      );
    default:
      return Effect.fail(
        runtimeEffectError(
          "plugin-keychain-secret-store",
          `keychain.get: unsupported on platform '${process.platform}'`,
        ),
      );
  }
};

const writeKeychainSecretValue = (input: {
  providerHandle: string;
  name?: string | null;
  value: string;
  keychainServiceName: string;
}) => {
  const secretName = trimOrNull(input.name);

  switch (process.platform) {
    case "darwin":
      return runCommand({
        command: "security",
        args: [
          "add-generic-password",
          "-a",
          input.providerHandle,
          "-s",
          input.keychainServiceName,
          "-w",
          input.value,
          "-U",
          ...(secretName ? ["-l", secretName] : []),
        ],
        operation: "keychain.put",
        timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS,
      }).pipe(
        Effect.flatMap((result) =>
          ensureCommandSuccess({
            result,
            operation: "keychain.put",
            message: "Failed storing secret in macOS keychain",
          })),
        Effect.asVoid,
      );
    case "linux":
      return runCommand({
        command: "secret-tool",
        args: [
          "store",
          "--label",
          secretName ?? input.keychainServiceName,
          "service",
          input.keychainServiceName,
          "account",
          input.providerHandle,
        ],
        stdin: input.value,
        operation: "keychain.put",
        timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS,
      }).pipe(
        Effect.flatMap((result) =>
          ensureCommandSuccess({
            result,
            operation: "keychain.put",
            message: "Failed storing secret in desktop keyring",
          })),
        Effect.asVoid,
      );
    default:
      return Effect.fail(
        runtimeEffectError(
          "plugin-keychain-secret-store",
          `keychain.put: unsupported on platform '${process.platform}'`,
        ),
      );
  }
};

const deleteKeychainSecretValue = (input: {
  providerHandle: string;
  keychainServiceName: string;
}) => {
  switch (process.platform) {
    case "darwin":
      return runCommand({
        command: "security",
        args: [
          "delete-generic-password",
          "-a",
          input.providerHandle,
          "-s",
          input.keychainServiceName,
        ],
        operation: "keychain.delete",
        timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS,
      }).pipe(Effect.map((result) => result.exitCode === 0));
    case "linux":
      return runCommand({
        command: "secret-tool",
        args: [
          "clear",
          "service",
          input.keychainServiceName,
          "account",
          input.providerHandle,
        ],
        operation: "keychain.delete",
        timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS,
      }).pipe(Effect.map((result) => result.exitCode === 0));
    default:
      return Effect.fail(
        runtimeEffectError(
          "plugin-keychain-secret-store",
          `keychain.delete: unsupported on platform '${process.platform}'`,
        ),
      );
  }
};

const builtinSecretStoreStorage = <TStored>(value: TStored) => ({
  get: () => Effect.succeed(value),
  put: () => Effect.void,
  remove: () => Effect.void,
});

export const keychainSecretStoreSdkPlugin = defineExecutorSecretStorePlugin({
  key: KEYCHAIN_SECRET_STORE_KIND,
  secretStore: {
    kind: KEYCHAIN_SECRET_STORE_KIND,
    displayName:
      process.platform === "darwin" ? "macOS Keychain" : "Desktop Keyring",
    builtin: {
      storeId: KEYCHAIN_SECRET_STORE_ID,
      defaultPriority: 10,
      enabled: () => process.platform === "darwin" || process.platform === "linux",
      createStore: () => ({
        kind: KEYCHAIN_SECRET_STORE_KIND,
        name: process.platform === "darwin" ? "macOS Keychain" : "Desktop Keyring",
        status: "connected",
        enabled: true,
      }),
    },
    storage: builtinSecretStoreStorage({}),
    store: {
      create: (input: { name: string }) => ({
        store: {
          kind: KEYCHAIN_SECRET_STORE_KIND,
          name: input.name,
          status: "connected",
          enabled: true,
        },
        stored: {},
      }),
      update: ({ store }) => ({
        store,
        stored: {},
      }),
      toConfig: ({ store }) => ({
        kind: KEYCHAIN_SECRET_STORE_KIND,
        name: store.name,
      }),
      resolveSecret: ({ secret }) =>
        readKeychainSecretValue({
          providerHandle: secret.handle,
          keychainServiceName: resolveKeychainServiceName(undefined),
        }),
      createSecret: ({ value, name }) =>
        Effect.gen(function* () {
          const providerHandle = randomUUID();
          yield* writeKeychainSecretValue({
            providerHandle,
            name,
            value,
            keychainServiceName: resolveKeychainServiceName(undefined),
          });
          return {
            handle: providerHandle,
            name: trimOrNull(name),
            value: null,
          };
        }),
      updateSecret: ({ secret, name, value }) =>
        Effect.gen(function* () {
          const keychainServiceName = resolveKeychainServiceName(undefined);
          const nextName = trimOrNull(name ?? secret.name);
          const nextValue = value
            ?? (yield* readKeychainSecretValue({
              providerHandle: secret.handle,
              keychainServiceName,
            }));
          yield* writeKeychainSecretValue({
            providerHandle: secret.handle,
            name: nextName,
            value: nextValue,
            keychainServiceName,
          });
          return {
            handle: secret.handle,
            name: nextName,
            value: null,
          };
        }),
      deleteSecret: ({ secret }) =>
        deleteKeychainSecretValue({
          providerHandle: secret.handle,
          keychainServiceName: resolveKeychainServiceName(undefined),
        }),
      capabilities: () => ({
        canCreateSecrets: true,
        canUpdateSecrets: true,
        canDeleteSecrets: true,
        canBrowseSecrets: false,
        canImportSecrets: false,
      }),
    },
  },
});

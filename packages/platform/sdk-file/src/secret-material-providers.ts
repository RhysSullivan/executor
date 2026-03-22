import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";

import {
  type LocalConfigSecretProvider,
  type LocalExecutorConfig,
  type SecretMaterialPurpose,
  type SecretRef,
  type SecretMaterial,
  SecretMaterialIdSchema,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  LocalInstanceConfigService,
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
  type ResolveSecretMaterial,
  type ResolveInstanceConfig,
  type SecretMaterialResolveContext,
  type StoreSecretMaterial,
  type DeleteSecretMaterial,
  type UpdateSecretMaterial,
} from "../../sdk/src/runtime/workspace/secret-material-providers";
import { fromConfigSecretProviderId } from "../../sdk/src/runtime/workspace/config-secrets";
import { getRuntimeLocalWorkspaceOption } from "../../sdk/src/runtime/workspace/runtime-context";
import {
  ExecutorStateStore,
  type ExecutorStateStoreShape,
} from "../../sdk/src/runtime/executor-state-store";
import { runtimeEffectError } from "../../sdk/src/runtime/effect-errors";
import { resolveConfigRelativePath } from "./config";

export const ENV_SECRET_PROVIDER_ID = "env";
export const PARAMS_SECRET_PROVIDER_ID = "params";
export const KEYCHAIN_SECRET_PROVIDER_ID = "keychain";
export const LOCAL_SECRET_PROVIDER_ID = "local";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export type SecretStoreProviderId =
  | typeof KEYCHAIN_SECRET_PROVIDER_ID
  | typeof LOCAL_SECRET_PROVIDER_ID;

type SecretMaterialProviderRuntime = {
  executorState: ExecutorStateStoreShape;
  env: NodeJS.ProcessEnv;
  dangerouslyAllowEnvSecrets: boolean;
  keychainServiceName: string;
  localConfig: LocalExecutorConfig | null;
  workspaceRoot: string | null;
};

type SecretMaterialProvider = {
  resolve: (input: {
    ref: SecretRef;
    context: SecretMaterialResolveContext;
    runtime: SecretMaterialProviderRuntime;
  }) => Effect.Effect<string, Error, never>;
  store?: (input: {
    purpose: SecretMaterialPurpose;
    value: string;
    name?: string | null;
    runtime: SecretMaterialProviderRuntime;
  }) => Effect.Effect<SecretRef, Error, never>;
  update?: (input: {
    ref: SecretRef;
    name?: string | null;
    value?: string;
    runtime: SecretMaterialProviderRuntime;
  }) => Effect.Effect<{
    id: string;
    providerId: string;
    name: string | null;
    purpose: string;
    createdAt: number;
    updatedAt: number;
  }, Error, never>;
  remove?: (input: {
    ref: SecretRef;
    runtime: SecretMaterialProviderRuntime;
  }) => Effect.Effect<boolean, Error, never>;
};

type SecretMaterialProviderRegistry = ReadonlyMap<string, SecretMaterialProvider>;

type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const DEFAULT_KEYCHAIN_SERVICE_NAME = "executor";
const KEYCHAIN_COMMAND_TIMEOUT_MS = 5_000;
const DANGEROUSLY_ALLOW_ENV_SECRETS_ENV = "DANGEROUSLY_ALLOW_ENV_SECRETS";
const SECRET_STORE_PROVIDER_ENV = "EXECUTOR_SECRET_STORE_PROVIDER";
const KEYCHAIN_SERVICE_NAME_ENV = "EXECUTOR_KEYCHAIN_SERVICE_NAME";

type SecretMaterialSummary = {
  id: string;
  providerId: string;
  name: string | null;
  purpose: string;
  createdAt: number;
  updatedAt: number;
};

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseBooleanEnv = (value: string | undefined): boolean => {
  const normalized = trimOrNull(value)?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

export const parseSecretStoreProviderId = (value: string | undefined): SecretStoreProviderId | null => {
  const normalized = trimOrNull(value)?.toLowerCase();
  if (normalized === KEYCHAIN_SECRET_PROVIDER_ID) {
    return KEYCHAIN_SECRET_PROVIDER_ID;
  }

  if (
    normalized === LOCAL_SECRET_PROVIDER_ID
  ) {
    return LOCAL_SECRET_PROVIDER_ID;
  }

  return null;
};

const resolveDangerouslyAllowEnvSecrets = (value: boolean | undefined): boolean =>
  value ?? parseBooleanEnv(process.env[DANGEROUSLY_ALLOW_ENV_SECRETS_ENV]);

const resolveKeychainServiceName = (value: string | undefined): string =>
  trimOrNull(value)
  ?? trimOrNull(process.env[KEYCHAIN_SERVICE_NAME_ENV])
  ?? DEFAULT_KEYCHAIN_SERVICE_NAME;

const ensureNonEmptyString = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const toSecretMaterialSummary = (
  material: Pick<SecretMaterial, "id" | "providerId" | "name" | "purpose" | "createdAt" | "updatedAt">,
): SecretMaterialSummary => ({
  id: material.id,
  providerId: material.providerId,
  name: material.name,
  purpose: material.purpose,
  createdAt: material.createdAt,
  updatedAt: material.updatedAt,
});

const keychainCommandForPlatform = (
  platform: NodeJS.Platform = process.platform,
): string | null => {
  if (platform === "darwin") {
    return "security";
  }

  if (platform === "linux") {
    return "secret-tool";
  }

  return null;
};

const runCommand = (input: {
  command: string;
  args: ReadonlyArray<string>;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  operation: string;
  timeoutMs?: number;
}): Effect.Effect<SpawnResult, Error, never> =>
  Effect.tryPromise({
    try: () =>
      new Promise<SpawnResult>((resolve, reject) => {
        const child = spawn(input.command, [...input.args], {
          stdio: "pipe",
          env: input.env,
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
          reject(new Error(`${input.operation}: failed spawning '${input.command}': ${error.message}`));
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
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`${input.operation}: command execution failed: ${String(cause)}`),
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

  return Effect.fail(runtimeEffectError("local/secret-material-providers", `${input.operation}: ${input.message}: ${details}`));
};

const commandAvailabilityCache = new Map<string, Promise<boolean>>();

const commandExists = (command: string): Effect.Effect<boolean, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      const cached = commandAvailabilityCache.get(command);
      if (cached) {
        return cached;
      }

      const probe = new Promise<boolean>((resolve) => {
        const child = spawn(command, ["--help"], {
          stdio: "ignore",
        });
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(false);
        }, 2_000);

        child.on("error", () => {
          clearTimeout(timeout);
          resolve(false);
        });
        child.on("close", () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });

      commandAvailabilityCache.set(command, probe);
      const available = await probe;
      if (!available) {
        commandAvailabilityCache.delete(command);
      }
      return available;
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`command.exists: failed checking '${command}': ${String(cause)}`),
  });

const isKeychainProviderAvailable = (
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<boolean, Error, never> => {
  const command = keychainCommandForPlatform(platform);
  return command === null ? Effect.succeed(false) : commandExists(command);
};

export const resolveDefaultSecretStoreProviderId = (input: {
  storeProviderId?: SecretStoreProviderId;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
} = {}): Effect.Effect<SecretStoreProviderId, never, never> => {
  const localProviderId = LOCAL_SECRET_PROVIDER_ID as SecretStoreProviderId;
  const explicit =
    input.storeProviderId
    ?? parseSecretStoreProviderId((input.env ?? process.env)[SECRET_STORE_PROVIDER_ENV]);
  if (explicit) {
    return Effect.succeed(explicit);
  }

  if ((input.platform ?? process.platform) !== "darwin") {
    return Effect.succeed(localProviderId);
  }

  return isKeychainProviderAvailable(input.platform).pipe(
    Effect.map((available): SecretStoreProviderId =>
      available ? KEYCHAIN_SECRET_PROVIDER_ID : localProviderId),
    Effect.catchAll(() => Effect.succeed(localProviderId)),
  ) as Effect.Effect<SecretStoreProviderId, never, never>;
};

const loadStoredSecretMaterial = (input: {
  id: string;
  runtime: SecretMaterialProviderRuntime;
  operation: string;
}) =>
  Effect.gen(function* () {
    const materialId = SecretMaterialIdSchema.make(input.id);
    const stored = yield* input.runtime.executorState.secretMaterials.getById(materialId);
    if (Option.isNone(stored)) {
      return yield* runtimeEffectError("local/secret-material-providers", `${input.operation}: secret material not found: ${input.id}`);
    }

    return stored.value;
  });

const createSecretMaterialMetadata = (input: {
  providerId: SecretStoreProviderId;
  providerHandle: string;
  purpose: SecretMaterialPurpose;
  value: string | null;
  name?: string | null;
  runtime: SecretMaterialProviderRuntime;
}) =>
  Effect.gen(function* () {
    const now = Date.now();
    const id = SecretMaterialIdSchema.make(`sec_${randomUUID()}`);
    yield* input.runtime.executorState.secretMaterials.upsert({
      id,
      providerId: input.providerId,
      handle: input.providerHandle,
      name: trimOrNull(input.name),
      purpose: input.purpose,
      value: input.value,
      createdAt: now,
      updatedAt: now,
    });

    return {
      providerId: input.providerId,
      handle: id,
    } satisfies SecretRef;
  });

const loadManagedKeychainRef = (input: {
  ref: SecretRef;
  runtime: SecretMaterialProviderRuntime;
  operation: string;
}) =>
  Effect.gen(function* () {
    const material = yield* loadStoredSecretMaterial({
      id: input.ref.handle,
      runtime: input.runtime,
      operation: input.operation,
    });
    if (material.providerId !== KEYCHAIN_SECRET_PROVIDER_ID) {
      return yield* runtimeEffectError("local/secret-material-providers", 
          `${input.operation}: secret ${material.id} is stored in provider '${material.providerId}', not '${KEYCHAIN_SECRET_PROVIDER_ID}'`,
        );
    }

    return {
      providerHandle: material.handle,
      material,
    };
  });

const readKeychainSecretValue = (input: {
  providerHandle: string;
  runtime: SecretMaterialProviderRuntime;
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
          input.runtime.keychainServiceName,
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
          }),
        ),
        Effect.map((result) => result.stdout.trimEnd()),
      );
    case "linux":
      return runCommand({
        command: "secret-tool",
        args: [
          "lookup",
          "service",
          input.runtime.keychainServiceName,
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
          }),
        ),
        Effect.map((result) => result.stdout.trimEnd()),
      );
    default:
      return Effect.fail(
        runtimeEffectError("local/secret-material-providers", `keychain.get: keychain provider is unsupported on platform '${process.platform}'`),
      );
  }
};

const writeKeychainSecretValue = (input: {
  providerHandle: string;
  name?: string | null;
  value: string;
  runtime: SecretMaterialProviderRuntime;
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
          input.runtime.keychainServiceName,
          "-w",
          input.value,
          ...(secretName ? ["-l", secretName] : []),
          "-U",
        ],
        operation: "keychain.put",
        timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS,
      }).pipe(
        Effect.flatMap((result) =>
          ensureCommandSuccess({
            result,
            operation: "keychain.put",
            message: "Failed storing secret in macOS keychain",
          }),
        ),
      );
    case "linux":
      return runCommand({
        command: "secret-tool",
        args: [
          "store",
          "--label",
          secretName ?? input.runtime.keychainServiceName,
          "service",
          input.runtime.keychainServiceName,
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
          }),
        ),
      );
    default:
      return Effect.fail(
        runtimeEffectError("local/secret-material-providers", `keychain.put: keychain provider is unsupported on platform '${process.platform}'`),
      );
  }
};

const deleteKeychainSecretValue = (input: {
  providerHandle: string;
  runtime: SecretMaterialProviderRuntime;
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
          input.runtime.keychainServiceName,
        ],
        operation: "keychain.delete",
        timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS,
      }).pipe(
        Effect.map((result) => result.exitCode === 0),
      );
    case "linux":
      return runCommand({
        command: "secret-tool",
        args: [
          "clear",
          "service",
          input.runtime.keychainServiceName,
          "account",
          input.providerHandle,
        ],
        operation: "keychain.delete",
        timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS,
      }).pipe(
        Effect.map((result) => result.exitCode === 0),
      );
    default:
      return Effect.fail(
        runtimeEffectError("local/secret-material-providers", `keychain.delete: keychain provider is unsupported on platform '${process.platform}'`),
      );
  }
};

const createParamsSecretMaterialProvider = (): SecretMaterialProvider => ({
  resolve: ({ ref, context }) => {
    const value = ensureNonEmptyString(context.params?.[ref.handle]);
    if (value === null) {
      return Effect.fail(runtimeEffectError("local/secret-material-providers", `Secret parameter ${ref.handle} is not set`));
    }

    return Effect.succeed(value);
  },

  remove: () => Effect.succeed(false),
});

const createEnvSecretMaterialProvider = (): SecretMaterialProvider => ({
  resolve: ({ ref, runtime }) => {
    if (!runtime.dangerouslyAllowEnvSecrets) {
      return Effect.fail(
        runtimeEffectError("local/secret-material-providers", 
          `Env-backed secrets are disabled. Set ${DANGEROUSLY_ALLOW_ENV_SECRETS_ENV}=true to allow provider '${ENV_SECRET_PROVIDER_ID}'.`,
        ),
      );
    }

    const value = ensureNonEmptyString(runtime.env[ref.handle]);
    if (value === null) {
      return Effect.fail(runtimeEffectError("local/secret-material-providers", `Environment variable ${ref.handle} is not set`));
    }

    return Effect.succeed(value);
  },

  remove: () => Effect.succeed(false),
});

const createLocalSecretMaterialProvider = (): SecretMaterialProvider => ({
  resolve: ({ ref, runtime }) =>
    Effect.gen(function* () {
      const stored = yield* loadStoredSecretMaterial({
        id: ref.handle,
        runtime,
        operation: "local.get",
      });
      if (stored.providerId !== LOCAL_SECRET_PROVIDER_ID) {
        return yield* runtimeEffectError("local/secret-material-providers", 
            `local.get: secret ${stored.id} is stored in provider '${stored.providerId}', not '${LOCAL_SECRET_PROVIDER_ID}'`,
          );
      }
      if (stored.value === null) {
        return yield* runtimeEffectError("local/secret-material-providers", `local.get: secret ${stored.id} does not have a local value`);
      }

      return stored.value;
    }),

  store: ({ purpose, value, name, runtime }) =>
    createSecretMaterialMetadata({
      providerId: LOCAL_SECRET_PROVIDER_ID,
      providerHandle: `local:${randomUUID()}`,
      purpose,
      value,
      name,
      runtime,
    }),

  update: ({ ref, name, value, runtime }) =>
    Effect.gen(function* () {
      const stored = yield* loadStoredSecretMaterial({
        id: ref.handle,
        runtime,
        operation: "local.update",
      });
      if (stored.providerId !== LOCAL_SECRET_PROVIDER_ID) {
        return yield* runtimeEffectError("local/secret-material-providers", 
            `local.update: secret ${stored.id} is stored in provider '${stored.providerId}', not '${LOCAL_SECRET_PROVIDER_ID}'`,
          );
      }

      if (name === undefined && value === undefined) {
        return toSecretMaterialSummary(stored);
      }

      const updated = yield* runtime.executorState.secretMaterials.updateById(
        stored.id,
        {
          ...(name !== undefined ? { name } : {}),
          ...(value !== undefined ? { value } : {}),
        },
      );
      if (Option.isNone(updated)) {
        return yield* runtimeEffectError("local/secret-material-providers", `local.update: secret material not found: ${stored.id}`);
      }

      return {
        id: updated.value.id,
        providerId: updated.value.providerId,
        name: updated.value.name,
        purpose: updated.value.purpose,
        createdAt: updated.value.createdAt,
        updatedAt: updated.value.updatedAt,
      } satisfies SecretMaterialSummary;
    }),

  remove: ({ ref, runtime }) =>
    Effect.gen(function* () {
      const materialId = SecretMaterialIdSchema.make(ref.handle);
      return yield* runtime.executorState.secretMaterials.removeById(materialId);
    }),
});

const createKeychainSecretMaterialProvider = (): SecretMaterialProvider => ({
  resolve: ({ ref, runtime }) =>
    Effect.gen(function* () {
      const loaded = yield* loadManagedKeychainRef({
        ref,
        runtime,
        operation: "keychain.get",
      });

      return yield* readKeychainSecretValue({
        providerHandle: loaded.providerHandle,
        runtime,
      });
    }),

  store: ({ purpose, value, name, runtime }) =>
    Effect.gen(function* () {
      const providerHandle = randomUUID();
      yield* writeKeychainSecretValue({
        providerHandle,
        name,
        value,
        runtime,
      });

      return yield* createSecretMaterialMetadata({
        providerId: KEYCHAIN_SECRET_PROVIDER_ID,
        providerHandle,
        purpose,
        value: null,
        name,
        runtime,
      });
    }),

  update: ({ ref, name, value, runtime }) =>
    Effect.gen(function* () {
      const loaded = yield* loadManagedKeychainRef({
        ref,
        runtime,
        operation: "keychain.update",
      });

      if (name === undefined && value === undefined) {
        return toSecretMaterialSummary(loaded.material);
      }

      const nextName = name ?? loaded.material.name;
      const nextValue = value
        ?? (yield* readKeychainSecretValue({
          providerHandle: loaded.providerHandle,
          runtime,
        }));

      yield* writeKeychainSecretValue({
        providerHandle: loaded.providerHandle,
        name: nextName,
        value: nextValue,
        runtime,
      });

      const updated = yield* runtime.executorState.secretMaterials.updateById(
        loaded.material.id,
        {
          name: nextName,
        },
      );
      if (Option.isNone(updated)) {
        return yield* runtimeEffectError("local/secret-material-providers", `keychain.update: secret material not found: ${loaded.material.id}`);
      }

      return {
        id: updated.value.id,
        providerId: updated.value.providerId,
        name: updated.value.name,
        purpose: updated.value.purpose,
        createdAt: updated.value.createdAt,
        updatedAt: updated.value.updatedAt,
      } satisfies SecretMaterialSummary;
    }),

  remove: ({ ref, runtime }) =>
    Effect.gen(function* () {
      const loaded = yield* loadManagedKeychainRef({
        ref,
        runtime,
        operation: "keychain.delete",
      });
      const deleted = yield* deleteKeychainSecretValue({
        providerHandle: loaded.providerHandle,
        runtime,
      });

      if (!deleted) {
        return false;
      }

      return yield* runtime.executorState.secretMaterials.removeById(loaded.material.id);
    }),
});

const createSecretMaterialProviderRegistry = (): SecretMaterialProviderRegistry =>
  new Map([
    [PARAMS_SECRET_PROVIDER_ID, createParamsSecretMaterialProvider()],
    [ENV_SECRET_PROVIDER_ID, createEnvSecretMaterialProvider()],
    [KEYCHAIN_SECRET_PROVIDER_ID, createKeychainSecretMaterialProvider()],
    [LOCAL_SECRET_PROVIDER_ID, createLocalSecretMaterialProvider()],
  ]);

const getSecretMaterialProvider = (input: {
  providers: SecretMaterialProviderRegistry;
  providerId: string;
}): Effect.Effect<SecretMaterialProvider, Error, never> => {
  const provider = input.providers.get(input.providerId);
  if (provider) {
    return Effect.succeed(provider);
  }

  return Effect.fail(runtimeEffectError("local/secret-material-providers", `Unsupported secret provider: ${input.providerId}`));
};

const createSecretMaterialProviderRuntime = (input: {
  executorState: ExecutorStateStoreShape;
  dangerouslyAllowEnvSecrets?: boolean;
  keychainServiceName?: string;
  localConfig?: LocalExecutorConfig | null;
  workspaceRoot?: string | null;
}): SecretMaterialProviderRuntime => ({
  executorState: input.executorState,
  env: process.env,
  dangerouslyAllowEnvSecrets: resolveDangerouslyAllowEnvSecrets(input.dangerouslyAllowEnvSecrets),
  keychainServiceName: resolveKeychainServiceName(input.keychainServiceName),
  localConfig: input.localConfig ?? null,
  workspaceRoot: input.workspaceRoot ?? null,
});

const isRegularFilePath = (
  path: string,
  allowSymlink: boolean,
): Effect.Effect<boolean, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(path).pipe(Effect.mapError(toError));
    if (stat.type === "SymbolicLink") {
      if (!allowSymlink) {
        return false;
      }

      const resolvedPath = yield* fs.realPath(path).pipe(Effect.mapError(toError));
      const targetStat = yield* fs.stat(resolvedPath).pipe(Effect.mapError(toError));
      return targetStat.type === "File";
    }

    return stat.type === "File";
  });

const ensureTrustedDir = (
  path: string,
  trustedDirs: readonly string[] | undefined,
): Effect.Effect<boolean, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (!trustedDirs || trustedDirs.length === 0) {
      return true;
    }

    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(path).pipe(Effect.mapError(toError));

    for (const dir of trustedDirs) {
      const trusted = yield* fs.realPath(dir).pipe(Effect.mapError(toError));
      if (real === trusted || real.startsWith(`${trusted}/`)) {
        return true;
      }
    }

    return false;
  });

const readFileSecretValue = (input: {
  provider: Extract<LocalConfigSecretProvider, { source: "file" }>;
  ref: SecretRef;
  workspaceRoot: string;
}): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const resolvedPath = resolveConfigRelativePath({
      path: input.provider.path,
      workspaceRoot: input.workspaceRoot,
    });
    const raw = yield* fs.readFileString(resolvedPath, "utf8").pipe(
      Effect.mapError(toError),
    );
    const mode = input.provider.mode ?? "singleValue";
    if (mode === "singleValue") {
      return raw.trim();
    }

    return yield* Effect.try({
      try: () => {
        const parsed = JSON.parse(raw) as unknown;
        if (input.ref.handle.startsWith("/")) {
          const segments = input.ref.handle
            .split("/")
            .slice(1)
            .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
          let current: unknown = parsed;
          for (const segment of segments) {
            if (typeof current !== "object" || current === null || !(segment in current)) {
              throw new Error(`Secret path not found in ${resolvedPath}: ${input.ref.handle}`);
            }
            current = (current as Record<string, unknown>)[segment];
          }
          if (typeof current !== "string" || current.trim().length === 0) {
            throw new Error(`Secret path did not resolve to a string: ${input.ref.handle}`);
          }
          return current;
        }

        if (typeof parsed !== "object" || parsed === null) {
          throw new Error(`JSON secret provider must resolve to an object: ${resolvedPath}`);
        }
        const value = (parsed as Record<string, unknown>)[input.ref.handle];
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new Error(`Secret key not found in ${resolvedPath}: ${input.ref.handle}`);
        }
        return value;
      },
      catch: toError,
    });
  });

const resolveConfiguredSecretProvider = (input: {
  ref: SecretRef;
  runtime: SecretMaterialProviderRuntime;
}): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const providerAlias = fromConfigSecretProviderId(input.ref.providerId);
    if (providerAlias === null) {
      return yield* runtimeEffectError(
        "local/secret-material-providers",
        `Unsupported secret provider: ${input.ref.providerId}`,
      );
    }

    const provider = input.runtime.localConfig?.secrets?.providers?.[providerAlias];
    if (!provider) {
      return yield* runtimeEffectError(
        "local/secret-material-providers",
        `Config secret provider "${providerAlias}" is not configured`,
      );
    }
    if (input.runtime.workspaceRoot === null) {
      return yield* runtimeEffectError(
        "local/secret-material-providers",
        `Config secret provider "${providerAlias}" requires a workspace root`,
      );
    }

    if (provider.source === "env") {
      const value = ensureNonEmptyString(input.runtime.env[input.ref.handle]);
      if (value === null) {
        return yield* runtimeEffectError(
          "local/secret-material-providers",
          `Environment variable ${input.ref.handle} is not set`,
        );
      }
      return value;
    }

    if (provider.source === "file") {
      return yield* readFileSecretValue({
        provider,
        ref: input.ref,
        workspaceRoot: input.runtime.workspaceRoot,
      });
    }

    const command = provider.command.trim();
    if (!isAbsolute(command)) {
      return yield* runtimeEffectError(
        "local/secret-material-providers",
        `Exec secret provider command must be absolute: ${command}`,
      );
    }
    const isRegularCommand = yield* isRegularFilePath(
      command,
      provider.allowSymlinkCommand ?? false,
    );
    if (!isRegularCommand) {
      return yield* runtimeEffectError(
        "local/secret-material-providers",
        `Exec secret provider command is not an allowed regular file: ${command}`,
      );
    }
    const isTrustedCommand = yield* ensureTrustedDir(command, provider.trustedDirs);
    if (!isTrustedCommand) {
      return yield* runtimeEffectError(
        "local/secret-material-providers",
        `Exec secret provider command is outside trustedDirs: ${command}`,
      );
    }

    return yield* runCommand({
      command,
      args: [...(provider.args ?? []), input.ref.handle],
      env: {
        ...input.runtime.env,
        ...provider.env,
      },
      operation: `config-secret.get:${providerAlias}`,
    }).pipe(
      Effect.flatMap((result) =>
        ensureCommandSuccess({
          result,
          operation: `config-secret.get:${providerAlias}`,
          message: "Failed resolving configured exec secret",
        }),
      ),
      Effect.map((result) => result.stdout.trimEnd()),
    );
  });

export const createDefaultSecretMaterialResolver = (input: {
  executorState: ExecutorStateStoreShape;
  dangerouslyAllowEnvSecrets?: boolean;
  keychainServiceName?: string;
  localConfig?: LocalExecutorConfig | null;
  workspaceRoot?: string | null;
}): ResolveSecretMaterial => {
  const providers = createSecretMaterialProviderRegistry();
  const runtime = createSecretMaterialProviderRuntime(input);

  return ({ ref, context }) =>
    Effect.gen(function* () {
      const provider = yield* getSecretMaterialProvider({
        providers,
        providerId: ref.providerId,
      }).pipe(
        Effect.catchAll(() =>
          fromConfigSecretProviderId(ref.providerId) !== null
            ? Effect.succeed(null)
            : Effect.fail(runtimeEffectError("local/secret-material-providers", `Unsupported secret provider: ${ref.providerId}`)),
        ),
      );

      if (provider === null) {
        return yield* resolveConfiguredSecretProvider({
          ref,
          runtime,
        });
      }

      return yield* provider.resolve({
        ref,
        context: context ?? {},
        runtime,
      });
    }).pipe(Effect.provide(NodeFileSystem.layer));
};

export const createDefaultSecretMaterialStorer = (input: {
  executorState: ExecutorStateStoreShape;
  dangerouslyAllowEnvSecrets?: boolean;
  keychainServiceName?: string;
}): StoreSecretMaterial => {
  const providers = createSecretMaterialProviderRegistry();
  const runtime = createSecretMaterialProviderRuntime(input);

  return ({ purpose, value, name, providerId }) =>
    Effect.gen(function* () {
      const defaultStoreProviderId = yield* resolveDefaultSecretStoreProviderId({
        storeProviderId: parseSecretStoreProviderId(providerId) ?? undefined,
        env: runtime.env,
      });
      const provider = yield* getSecretMaterialProvider({
        providers,
        providerId: defaultStoreProviderId,
      });

      if (!provider.store) {
        return yield* runtimeEffectError("local/secret-material-providers", `Secret provider ${defaultStoreProviderId} does not support storing secret material`);
      }

      return yield* provider.store({
        purpose,
        value,
        name,
        runtime,
      });
    });
};

export const createDefaultSecretMaterialUpdater = (input: {
  executorState: ExecutorStateStoreShape;
  dangerouslyAllowEnvSecrets?: boolean;
  keychainServiceName?: string;
}): UpdateSecretMaterial => {
  const providers = createSecretMaterialProviderRegistry();
  const runtime = createSecretMaterialProviderRuntime(input);

  return ({ ref, name, value }) =>
    Effect.gen(function* () {
      const provider = yield* getSecretMaterialProvider({
        providers,
        providerId: ref.providerId,
      });

      if (!provider.update) {
        return yield* runtimeEffectError("local/secret-material-providers", `Secret provider ${ref.providerId} does not support updating secret material`);
      }

      return yield* provider.update({
        ref,
        name,
        value,
        runtime,
      });
    });
};

export const createDefaultSecretMaterialDeleter = (input: {
  executorState: ExecutorStateStoreShape;
  dangerouslyAllowEnvSecrets?: boolean;
  keychainServiceName?: string;
}): DeleteSecretMaterial => {
  const providers = createSecretMaterialProviderRegistry();
  const runtime = createSecretMaterialProviderRuntime(input);

  return (ref) =>
    Effect.gen(function* () {
      const provider = yield* getSecretMaterialProvider({
        providers,
        providerId: ref.providerId,
      });

      if (!provider.remove) {
        return false;
      }

      return yield* provider.remove({
        ref,
        runtime,
      });
    });
};

const resolveRuntimeSecretMaterialConfig = (input: {
  localConfig?: LocalExecutorConfig | null;
  workspaceRoot?: string | null;
}) =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* getRuntimeLocalWorkspaceOption();

    return {
      localConfig: input.localConfig
        ?? runtimeLocalWorkspace?.loadedConfig.config
        ?? null,
      workspaceRoot: input.workspaceRoot
        ?? runtimeLocalWorkspace?.workspace.workspaceRoot
        ?? null,
    };
  });

export const SecretMaterialResolverLive = (input: {
  resolveSecretMaterial?: ResolveSecretMaterial;
  dangerouslyAllowEnvSecrets?: boolean;
  keychainServiceName?: string;
  localConfig?: LocalExecutorConfig | null;
  workspaceRoot?: string | null;
} = {}) =>
  input.resolveSecretMaterial
    ? Layer.succeed(SecretMaterialResolverService, input.resolveSecretMaterial)
    : Layer.effect(
        SecretMaterialResolverService,
        Effect.gen(function* () {
          const executorState = yield* ExecutorStateStore;
          const runtimeConfig = yield* resolveRuntimeSecretMaterialConfig(input);

          return createDefaultSecretMaterialResolver({
            executorState,
            dangerouslyAllowEnvSecrets: input.dangerouslyAllowEnvSecrets,
            keychainServiceName: input.keychainServiceName,
            localConfig: runtimeConfig.localConfig,
            workspaceRoot: runtimeConfig.workspaceRoot,
          });
        }),
      );

export const SecretMaterialStorerLive = (input: {
  dangerouslyAllowEnvSecrets?: boolean;
  keychainServiceName?: string;
} = {}) =>
  Layer.effect(
    SecretMaterialStorerService,
    Effect.gen(function* () {
      const executorState = yield* ExecutorStateStore;

      return createDefaultSecretMaterialStorer({
        executorState,
        dangerouslyAllowEnvSecrets: input.dangerouslyAllowEnvSecrets,
        keychainServiceName: input.keychainServiceName,
      });
    }),
  );

export const SecretMaterialDeleterLive = (input: {
  dangerouslyAllowEnvSecrets?: boolean;
  keychainServiceName?: string;
} = {}) =>
  Layer.effect(
    SecretMaterialDeleterService,
    Effect.gen(function* () {
      const executorState = yield* ExecutorStateStore;

      return createDefaultSecretMaterialDeleter({
        executorState,
        dangerouslyAllowEnvSecrets: input.dangerouslyAllowEnvSecrets,
        keychainServiceName: input.keychainServiceName,
      });
    }),
  );

export const SecretMaterialUpdaterLive = (input: {
  dangerouslyAllowEnvSecrets?: boolean;
  keychainServiceName?: string;
} = {}) =>
  Layer.effect(
    SecretMaterialUpdaterService,
    Effect.gen(function* () {
      const executorState = yield* ExecutorStateStore;

      return createDefaultSecretMaterialUpdater({
        executorState,
        dangerouslyAllowEnvSecrets: input.dangerouslyAllowEnvSecrets,
        keychainServiceName: input.keychainServiceName,
      });
    }),
  );

export const SecretMaterialLive = (input: {
  resolveSecretMaterial?: ResolveSecretMaterial;
  dangerouslyAllowEnvSecrets?: boolean;
  keychainServiceName?: string;
  localConfig?: LocalExecutorConfig | null;
  workspaceRoot?: string | null;
} = {}) =>
  Layer.mergeAll(
    SecretMaterialResolverLive(input),
    SecretMaterialStorerLive(input),
    SecretMaterialDeleterLive(input),
    SecretMaterialUpdaterLive(input),
  );

export const createLocalInstanceConfigResolver = (): ResolveInstanceConfig => () => {
  const explicitDefaultStoreProvider = parseSecretStoreProviderId(
    process.env[SECRET_STORE_PROVIDER_ENV],
  );
  const providers = [
    {
      id: LOCAL_SECRET_PROVIDER_ID,
      name: "Local store",
      canStore: true,
    },
  ];

  if (process.platform === "darwin" || process.platform === "linux") {
    providers.push({
      id: KEYCHAIN_SECRET_PROVIDER_ID,
      name:
        process.platform === "darwin" ? "macOS Keychain" : "Desktop Keyring",
      canStore:
        process.platform === "darwin" ||
        explicitDefaultStoreProvider === KEYCHAIN_SECRET_PROVIDER_ID,
    });
  }

  providers.push({
    id: ENV_SECRET_PROVIDER_ID,
    name: "Environment variable",
    canStore: false,
  });

  return resolveDefaultSecretStoreProviderId({
    storeProviderId: explicitDefaultStoreProvider ?? undefined,
  }).pipe(
    Effect.map((resolvedDefaultStoreProvider) => ({
      platform: process.platform,
      secretProviders: providers,
      defaultSecretStoreProvider: resolvedDefaultStoreProvider,
    })),
  );
};

export const LocalInstanceConfigLive = () =>
  Layer.succeed(LocalInstanceConfigService, createLocalInstanceConfigResolver());

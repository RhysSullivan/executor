import { Effect, Schema } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  definePlugin,
  StorageError,
  type PluginCtx,
  type SecretProvider,
} from "@executor-js/sdk/core";

// ---------------------------------------------------------------------------
// XDG data dir resolution
// ---------------------------------------------------------------------------

const APP_NAME = "executor";

export const xdgDataHome = (): string => {
  if (process.env.XDG_DATA_HOME?.trim()) return process.env.XDG_DATA_HOME.trim();
  if (process.platform === "win32") {
    return (
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(process.env.USERPROFILE || "~", "AppData", "Local")
    );
  }
  return path.join(process.env.HOME || "~", ".local", "share");
};

const authDir = (overrideDir?: string): string => overrideDir ?? path.join(xdgDataHome(), APP_NAME);

const authFilePath = (overrideDir?: string): string => path.join(authDir(overrideDir), "auth.json");

// ---------------------------------------------------------------------------
// Schema for the auth file
//
// Top-level keys are scope IDs, values are { secretId: secretValue } maps.
//   { "web-a1b2c3d4": { "github-token": "ghp_xxx" } }
// ---------------------------------------------------------------------------

const ScopedAuthFile = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String));
const decodeScopedAuthFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ScopedAuthFile));

// ---------------------------------------------------------------------------
// File I/O with restricted permissions
//
// These helpers keep real I/O and decode failures in the Effect error
// channel as `StorageError`. Missing files are still treated as an empty
// auth file, but malformed JSON, schema decode failures, and permission
// errors no longer collapse into "empty file".
// ---------------------------------------------------------------------------

const isFileNotFoundCause = (cause: unknown): cause is NodeJS.ErrnoException =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const toStorageError =
  (message: string) =>
  (cause: unknown): StorageError =>
    new StorageError({ message, cause });

const readFullFile = (
  filePath: string,
): Effect.Effect<Record<string, Record<string, string>>, StorageError> => {
  if (!fs.existsSync(filePath)) return Effect.succeed({});
  return Effect.try({
    try: () => fs.readFileSync(filePath, "utf-8"),
    catch: toStorageError("Failed to read auth file"),
  }).pipe(
    Effect.catchIf(
      (error) => isFileNotFoundCause(error.cause),
      () => Effect.succeed(""),
    ),
    Effect.flatMap((raw) =>
      raw === ""
        ? Effect.succeed({})
        : decodeScopedAuthFile(raw).pipe(
            Effect.mapError(toStorageError("Failed to parse auth file")),
          ),
    ),
  );
};

const readScopeSecrets = (
  filePath: string,
  scopeId: string,
): Effect.Effect<Record<string, string>, StorageError> =>
  readFullFile(filePath).pipe(Effect.map((file) => file[scopeId] ?? {}));

const writeScopeSecrets = (
  filePath: string,
  scopeId: string,
  secrets: Record<string, string>,
): Effect.Effect<void, StorageError> => {
  const dir = path.dirname(filePath);
  const tmp = `${filePath}.tmp`;
  return Effect.gen(function* () {
    if (!fs.existsSync(dir)) {
      yield* Effect.try({
        try: () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
        catch: toStorageError("Failed to create auth directory"),
      });
    }
    const full = yield* readFullFile(filePath);
    if (Object.keys(secrets).length === 0) {
      delete full[scopeId];
    } else {
      full[scopeId] = secrets;
    }
    yield* Effect.try({
      try: () => fs.writeFileSync(tmp, JSON.stringify(full, null, 2), { mode: 0o600 }),
      catch: toStorageError("Failed to write temporary auth file"),
    });
    yield* Effect.try({
      try: () => fs.renameSync(tmp, filePath),
      catch: toStorageError("Failed to replace auth file"),
    });
  });
};

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export interface FileSecretsPluginConfig {
  /** Override the directory for auth.json (default: XDG data dir) */
  readonly directory?: string;
}

// ---------------------------------------------------------------------------
// Plugin extension — public API on executor.fileSecrets
// ---------------------------------------------------------------------------

const makeFileSecretsExtension = (options: FileSecretsPluginConfig | undefined) => ({
  filePath: resolveFilePath(options),
});

export type FileSecretsExtension = ReturnType<typeof makeFileSecretsExtension>;

// ---------------------------------------------------------------------------
// Provider factory (internal)
// ---------------------------------------------------------------------------

// Scope arg is honored at every call: the auth.json is partitioned by
// scope id, so read/write/delete route to `file[scope][secretId]`. The
// provider is a singleton per executor; scope routing happens via the
// arg passed from the executor's secrets facade.
//
// `list` enumerates the innermost scope the provider was configured
// for — the executor's fallback/list path passes scope separately but
// the SecretProvider.list signature is scope-agnostic. That's fine for
// the current use: `list` feeds `secrets.list()` which already walks
// the stack at the caller layer. Innermost-first is the display default.
const makeScopedProvider = (filePath: string, listScope: string): SecretProvider => ({
  key: "file",
  writable: true,

  get: (secretId, scope) =>
    readScopeSecrets(filePath, scope).pipe(Effect.map((data) => data[secretId] ?? null)),

  has: (secretId, scope) =>
    readScopeSecrets(filePath, scope).pipe(Effect.map((data) => secretId in data)),

  set: (secretId, value, scope) =>
    Effect.gen(function* () {
      const data = yield* readScopeSecrets(filePath, scope);
      data[secretId] = value;
      yield* writeScopeSecrets(filePath, scope, data);
    }),

  delete: (secretId, scope) =>
    Effect.gen(function* () {
      const data = yield* readScopeSecrets(filePath, scope);
      const had = secretId in data;
      delete data[secretId];
      if (had) yield* writeScopeSecrets(filePath, scope, data);
      return had;
    }),

  list: () =>
    readScopeSecrets(filePath, listScope).pipe(
      Effect.map((data) => Object.keys(data).map((k) => ({ id: k, name: k }))),
    ),
});

// ---------------------------------------------------------------------------
// Plugin definition
//
// Compute the scoped file path identically in `extension` (for `filePath`)
// and `secretProviders` (for the provider's read/write). Both receive ctx
// and both are called once per createExecutor.
// ---------------------------------------------------------------------------

const resolveFilePath = (config: FileSecretsPluginConfig | undefined): string =>
  authFilePath(config?.directory);

export const fileSecretsPlugin = definePlugin((options?: FileSecretsPluginConfig) => ({
  id: "fileSecrets" as const,
  storage: () => ({}),

  extension: () => makeFileSecretsExtension(options),

  secretProviders: (ctx: PluginCtx<unknown>) => [
    // list() falls back to the innermost scope for display; per-call
    // get/set/delete honor the scope arg threaded from the secrets facade.
    makeScopedProvider(resolveFilePath(options), ctx.scopes[0]!.id),
  ],
}));

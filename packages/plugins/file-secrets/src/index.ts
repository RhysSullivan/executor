import { Effect, Schema } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  definePlugin,
  StorageError,
  type PluginCtx,
  type SecretProvider,
} from "@executor/sdk";

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

const authDir = (overrideDir?: string): string =>
  overrideDir ?? path.join(xdgDataHome(), APP_NAME);

const authFilePath = (overrideDir?: string): string =>
  path.join(authDir(overrideDir), "auth.json");

// ---------------------------------------------------------------------------
// Schema for the auth file
//
// Top-level keys are scope IDs, values are { secretId: secretValue } maps.
//   { "web-a1b2c3d4": { "github-token": "ghp_xxx" } }
// ---------------------------------------------------------------------------

const ScopedAuthFile = Schema.Record({
  key: Schema.String,
  value: Schema.Record({ key: Schema.String, value: Schema.String }),
});
const decodeScopedAuthFile = Schema.decodeUnknownSync(ScopedAuthFile);

// ---------------------------------------------------------------------------
// File I/O with restricted permissions
//
// These helpers throw on real I/O or decode failures — the provider wraps
// every call in `Effect.try` so those throws surface as typed
// `StorageError` on the Effect error channel. Previously `readFullFile`
// used a blanket `try { ... } catch { return {}; }` which masked JSON
// parse errors, schema decode failures, and permission errors as
// "empty file", making misconfigured installs silently return null from
// every `get`.
// ---------------------------------------------------------------------------

const readFullFile = (filePath: string): Record<string, Record<string, string>> => {
  if (!fs.existsSync(filePath)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (cause) {
    // Treat "file disappeared between existsSync and readFileSync" as
    // absence — anything else (EACCES, EISDIR, …) propagates.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw cause;
  }
  return decodeScopedAuthFile(JSON.parse(raw));
};

const readScopeSecrets = (filePath: string, scopeId: string): Record<string, string> =>
  readFullFile(filePath)[scopeId] ?? {};

const writeScopeSecrets = (
  filePath: string,
  scopeId: string,
  secrets: Record<string, string>,
): void => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const full = readFullFile(filePath);
  if (Object.keys(secrets).length === 0) {
    delete full[scopeId];
  } else {
    full[scopeId] = secrets;
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
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

export interface FileSecretsExtension {
  /** Path to the auth file */
  readonly filePath: string;
}

// ---------------------------------------------------------------------------
// Provider factory (internal)
// ---------------------------------------------------------------------------

const toStorageError = (cause: unknown) =>
  new StorageError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

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
const makeScopedProvider = (
  filePath: string,
  listScope: string,
): SecretProvider => ({
  key: "file",
  writable: true,

  get: (secretId, scope) =>
    Effect.try({
      try: () => {
        const data = readScopeSecrets(filePath, scope);
        return data[secretId] ?? null;
      },
      catch: toStorageError,
    }),

  set: (secretId, value, scope) =>
    Effect.try({
      try: () => {
        const data = readScopeSecrets(filePath, scope);
        data[secretId] = value;
        writeScopeSecrets(filePath, scope, data);
      },
      catch: toStorageError,
    }),

  delete: (secretId, scope) =>
    Effect.try({
      try: () => {
        const data = readScopeSecrets(filePath, scope);
        const had = secretId in data;
        delete data[secretId];
        if (had) writeScopeSecrets(filePath, scope, data);
        return had;
      },
      catch: toStorageError,
    }),

  list: () =>
    Effect.try({
      try: () => {
        const data = readScopeSecrets(filePath, listScope);
        return Object.keys(data).map((k) => ({ id: k, name: k }));
      },
      catch: toStorageError,
    }),
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

export const fileSecretsPlugin = definePlugin(
  (options?: FileSecretsPluginConfig) => ({
    id: "fileSecrets" as const,
    storage: () => ({}),

    extension: (_ctx): FileSecretsExtension => ({
      filePath: resolveFilePath(options),
    }),

    secretProviders: (ctx: PluginCtx<unknown>) => [
      // list() falls back to the innermost scope for display; per-call
      // get/set/delete honor the scope arg threaded from the secrets facade.
      makeScopedProvider(resolveFilePath(options), ctx.scopes[0]!.id as string),
    ],
  }),
);

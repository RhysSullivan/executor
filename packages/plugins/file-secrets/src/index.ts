import { Effect, Schema } from "effect";
import {
  definePlugin,
  type ExecutorPlugin,
  type SecretProvider,
} from "@executor/core";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// XDG data dir resolution
// ---------------------------------------------------------------------------

const APP_NAME = "executor";

const xdgDataHome = (): string =>
  process.env.XDG_DATA_HOME?.trim() ||
  path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".local",
    "share",
  );

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
// ---------------------------------------------------------------------------

const readFullFile = (
  filePath: string,
): Record<string, Record<string, string>> => {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf-8");
    return decodeScopedAuthFile(JSON.parse(raw));
  } catch {
    return {};
  }
};

const readScopeSecrets = (
  filePath: string,
  scopeId: string,
): Record<string, string> => readFullFile(filePath)[scopeId] ?? {};

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

const makeScopedProvider = (
  filePath: string,
  scopeId: string,
): SecretProvider => ({
  key: "file",
  writable: true,

  get: (secretId) =>
    Effect.sync(() => {
      const data = readScopeSecrets(filePath, scopeId);
      return data[secretId] ?? null;
    }),

  set: (secretId, value) =>
    Effect.sync(() => {
      const data = readScopeSecrets(filePath, scopeId);
      data[secretId] = value;
      writeScopeSecrets(filePath, scopeId, data);
    }),

  delete: (secretId) =>
    Effect.sync(() => {
      const data = readScopeSecrets(filePath, scopeId);
      const had = secretId in data;
      delete data[secretId];
      if (had) writeScopeSecrets(filePath, scopeId, data);
      return had;
    }),

  list: () =>
    Effect.sync(() => {
      const data = readScopeSecrets(filePath, scopeId);
      return Object.keys(data).map((k) => ({ id: k, name: k }));
    }),
});

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const PLUGIN_KEY = "fileSecrets";

export const fileSecretsPlugin = (
  config?: FileSecretsPluginConfig,
): ExecutorPlugin<typeof PLUGIN_KEY, FileSecretsExtension> =>
  definePlugin({
    key: PLUGIN_KEY,
    init: (ctx) =>
      Effect.gen(function* () {
        const filePath = authFilePath(config?.directory);

        yield* ctx.secrets.addProvider(
          makeScopedProvider(filePath, ctx.scope.id),
        );

        return {
          extension: { filePath },
        };
      }),
  });

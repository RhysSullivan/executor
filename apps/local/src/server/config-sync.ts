// ---------------------------------------------------------------------------
// Boot-time sync — replays sources from executor.jsonc into the executor.
// Plugins upsert so a re-sync on an already-populated DB is a no-op.
// Write-back (DB → file) is handled by the ConfigFileSink passed to each
// plugin in executor.ts.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { join } from "node:path";
import * as fs from "node:fs";
import * as jsonc from "jsonc-parser";

import type {
  SourceConfig,
  ExecutorFileConfig,
  ConfigHeaderValue,
} from "@executor/config";
import { SECRET_REF_PREFIX } from "@executor/config";

import type { LocalExecutor } from "./executor";

// ---------------------------------------------------------------------------
// Header translation: config format → plugin format
// ---------------------------------------------------------------------------

const translateHeader = (
  value: ConfigHeaderValue,
): string | { secretId: string; prefix?: string } => {
  if (typeof value === "string") {
    if (value.startsWith(SECRET_REF_PREFIX)) {
      return { secretId: value.slice(SECRET_REF_PREFIX.length) };
    }
    return value;
  }
  // Object form: { value, prefix? }
  if (typeof value.value === "string" && value.value.startsWith(SECRET_REF_PREFIX)) {
    return {
      secretId: value.value.slice(SECRET_REF_PREFIX.length),
      prefix: value.prefix,
    };
  }
  return value.value;
};

const translateHeaders = (
  headers: Record<string, ConfigHeaderValue> | undefined,
): Record<string, string | { secretId: string; prefix?: string }> | undefined => {
  if (!headers) return undefined;
  const out: Record<string, string | { secretId: string; prefix?: string }> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = translateHeader(v);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Config path resolution
// ---------------------------------------------------------------------------

export const resolveConfigPath = (scopeDir: string): string =>
  join(scopeDir, "executor.jsonc");

// ---------------------------------------------------------------------------
// Load config (sync, no Effect deps — runs at startup)
// ---------------------------------------------------------------------------

const loadConfigSync = (path: string): ExecutorFileConfig | null => {
  if (!fs.existsSync(path)) return null;
  const raw = fs.readFileSync(path, "utf-8");
  const errors: jsonc.ParseError[] = [];
  const parsed = jsonc.parse(raw, errors);
  if (errors.length > 0) {
    console.warn(`[config-sync] Failed to parse ${path}:`, errors);
    return null;
  }
  return parsed as ExecutorFileConfig;
};

// ---------------------------------------------------------------------------
// Sync from config → DB
// ---------------------------------------------------------------------------

const addSourceFromConfig = (
  executor: LocalExecutor,
  source: SourceConfig,
): Effect.Effect<void, unknown> => {
  // `executor.jsonc` is a single-scope artifact today — the file isn't
  // aware of per-user tenancy. Pin replayed sources to the outermost
  // scope so a future `[user, org]` stack still sees them via org
  // fall-through.
  const scope = executor.scopes.at(-1)!.id as string;
  switch (source.kind) {
    case "openapi":
      return executor.openapi.addSpec({
        spec: source.spec,
        scope,
        baseUrl: source.baseUrl,
        namespace: source.namespace,
        headers: translateHeaders(source.headers),
      }).pipe(Effect.asVoid);

    case "graphql":
      return executor.graphql.addSource({
        endpoint: source.endpoint,
        scope,
        namespace: source.namespace,
        headers: translateHeaders(source.headers) as Record<string, string> | undefined,
      }).pipe(Effect.asVoid);

    case "mcp":
      if (source.transport === "stdio") {
        return executor.mcp.addSource({
          transport: "stdio",
          scope,
          name: source.name,
          command: source.command,
          args: source.args ? [...source.args] : undefined,
          env: source.env,
          cwd: source.cwd,
          namespace: source.namespace,
        }).pipe(Effect.asVoid);
      }
      return executor.mcp.addSource({
        transport: "remote",
        scope,
        name: source.name,
        endpoint: source.endpoint,
        remoteTransport: source.remoteTransport,
        queryParams: source.queryParams,
        headers: source.headers,
        namespace: source.namespace,
      }).pipe(Effect.asVoid);
  }
};

/**
 * Read executor.jsonc and replay all sources into the executor.
 * Each source is added independently — if one fails, the rest still load.
 */
export const syncFromConfig = (
  executor: LocalExecutor,
  configPath: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const config = loadConfigSync(configPath);
    if (!config?.sources?.length) {
      console.log(`[config-sync] ${configPath} missing or empty, skipping`);
      return;
    }

    console.log(
      `[config-sync] syncing ${config.sources.length} source(s) from ${configPath}`,
    );

    const results = yield* Effect.forEach(
      config.sources,
      (source) =>
        addSourceFromConfig(executor, source).pipe(
          Effect.map(() => true as const),
          Effect.catchAll((e) => {
            const ns = "namespace" in source ? source.namespace : ("name" in source ? source.name : "unknown");
            console.warn(
              `[config-sync] Failed to load source "${ns}":`,
              e instanceof Error ? e.message : String(e),
            );
            return Effect.succeed(false as const);
          }),
        ),
      // Serial — bun:sqlite serializes transactions on a single connection,
      // so concurrent addSpec calls race on BEGIN.
      { concurrency: 1 },
    );

    const ok = results.filter(Boolean).length;
    console.log(`[config-sync] ${ok}/${results.length} source(s) synced`);
  });

import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { SecretNotFoundError, SetSecretInput, type SecretRef } from "@executor/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor/api";

type SecretUsage = {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly sourceKind: string;
};

const refToResponse = (ref: SecretRef, usedBy: readonly SecretUsage[]) => ({
  id: ref.id,
  scopeId: ref.scopeId,
  name: ref.name,
  provider: ref.provider,
  createdAt: ref.createdAt.getTime(),
  usedBy,
});

const isSecretRef = (value: unknown): value is { readonly secretId: string } =>
  typeof value === "object" &&
  value !== null &&
  "secretId" in value &&
  typeof value.secretId === "string";

const collectHeaderSecretIds = (headers: unknown): readonly string[] => {
  if (!headers || typeof headers !== "object") return [];
  const secretIds = new Set<string>();
  for (const value of Object.values(headers)) {
    if (isSecretRef(value)) {
      secretIds.add(value.secretId);
    }
  }
  return [...secretIds];
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;

const collectSecretIds = (pluginId: string, storedSource: unknown): readonly string[] => {
  const storedSourceRecord = asRecord(storedSource);
  if (!storedSourceRecord) return [];

  switch (pluginId) {
    case "openapi": {
      const config = asRecord(storedSourceRecord.config);
      const secretIds = new Set(collectHeaderSecretIds(config?.headers));
      const oauth2 = asRecord(config?.oauth2);
      for (const value of [
        oauth2?.clientIdSecretId,
        oauth2?.clientSecretSecretId,
        oauth2?.accessTokenSecretId,
        oauth2?.refreshTokenSecretId,
      ]) {
        if (typeof value === "string" && value.length > 0) {
          secretIds.add(value);
        }
      }
      return [...secretIds];
    }

    case "graphql":
      return collectHeaderSecretIds(storedSourceRecord.headers);

    case "mcp": {
      const config = asRecord(storedSourceRecord.config);
      if (!config || config.transport !== "remote") return [];
      const auth = asRecord(config.auth);
      if (!auth || typeof auth.kind !== "string") return [];
      if (auth.kind === "header" && typeof auth.secretId === "string") {
        return [auth.secretId];
      }
      if (auth.kind === "oauth2") {
        return [auth.accessTokenSecretId, auth.refreshTokenSecretId].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
      }
      return [];
    }

    case "googleDiscovery": {
      const config = asRecord(storedSourceRecord.config);
      const auth = asRecord(config?.auth);
      if (!auth || typeof auth !== "object" || auth.kind !== "oauth2") return [];
      return [
        auth.clientIdSecretId,
        auth.clientSecretSecretId,
        auth.accessTokenSecretId,
        auth.refreshTokenSecretId,
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
    }

    default:
      return [];
  }
};

type UsageSource = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly pluginId: string;
};

const getStoredSource = (
  executor: Record<string, any>,
  pluginId: string,
  sourceId: string,
  scopeId: string,
) => {
  switch (pluginId) {
    case "openapi":
      return executor.openapi?.getSource?.(sourceId, scopeId);
    case "graphql":
      return executor.graphql?.getSource?.(sourceId, scopeId);
    case "mcp":
      return executor.mcp?.getSource?.(sourceId, scopeId);
    case "googleDiscovery":
      return executor.googleDiscovery?.getSource?.(sourceId, scopeId);
    default:
      return undefined;
  }
};

const buildSecretUsageIndex = (executor: Record<string, any>, scopeId: string) =>
  Effect.gen(function* () {
    const sources = (yield* executor.sources.list().pipe(
      Effect.catchAll(() => Effect.succeed([])),
    )) as readonly UsageSource[];
    const usageIndex = new Map<string, Map<string, SecretUsage>>();

    for (const source of sources) {
      const loadStoredSource = getStoredSource(executor, source.pluginId, source.id, scopeId);
      if (!loadStoredSource) continue;

      const storedSource = yield* loadStoredSource.pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (!storedSource) continue;

      const usage = {
        sourceId: source.id,
        sourceName: source.name,
        sourceKind: source.kind,
      } satisfies SecretUsage;

      for (const secretId of collectSecretIds(source.pluginId, storedSource)) {
        const entries = usageIndex.get(secretId) ?? new Map<string, SecretUsage>();
        entries.set(source.id, usage);
        usageIndex.set(secretId, entries);
      }
    }

    return usageIndex;
  });

export const SecretsHandlers = HttpApiBuilder.group(ExecutorApi, "secrets", (handlers) =>
  handlers
    .handle("list", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const refs = yield* executor.secrets.list();
        const usageIndex = yield* buildSecretUsageIndex(
          executor as Record<string, any>,
          path.scopeId,
        ).pipe(Effect.catchAll(() => Effect.succeed(new Map<string, Map<string, SecretUsage>>())));
        return refs.map((ref) => {
          const usedBy = [...(usageIndex.get(ref.id)?.values() ?? [])].sort((a, b) =>
            a.sourceName.localeCompare(b.sourceName),
          );
          return refToResponse(ref, usedBy);
        });
      })),
    )
    .handle("status", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const status = yield* executor.secrets.status(path.secretId);
        return { secretId: path.secretId, status };
      })),
    )
    .handle("set", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const ref = yield* executor.secrets.set(
          new SetSecretInput({
            id: payload.id,
            scope: path.scopeId,
            name: payload.name,
            value: payload.value,
            provider: payload.provider,
          }),
        );
        return refToResponse(ref, []);
      })),
    )
    .handle("resolve", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const value = yield* executor.secrets.get(path.secretId);
        if (value === null) {
          return yield* new SecretNotFoundError({ secretId: path.secretId });
        }
        return { secretId: path.secretId, value };
      })),
    )
    .handle("remove", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        yield* executor.secrets.remove(path.secretId);
        return { removed: true };
      })),
    ),
);

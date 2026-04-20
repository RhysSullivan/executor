import { Effect } from "effect";
import type { Source } from "@executor/sdk";

export type SecretUsage = {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly sourceKind: string;
};

export type SecretUsageEntry = {
  readonly secretId: string;
  readonly usedBy: readonly SecretUsage[];
};

type SecretIdResolver = (sourceId: string, scopeId: string) => Effect.Effect<readonly string[], unknown>;

export type SecretUsageResolvers = Partial<Record<string, SecretIdResolver>>;

const sortUsage = (usedBy: readonly SecretUsage[]): readonly SecretUsage[] =>
  [...usedBy].sort((left, right) => left.sourceName.localeCompare(right.sourceName));

const addUsage = (
  usageIndex: Map<string, Map<string, SecretUsage>>,
  secretId: string,
  usage: SecretUsage,
) => {
  const entries = usageIndex.get(secretId) ?? new Map<string, SecretUsage>();
  entries.set(usage.sourceId, usage);
  usageIndex.set(secretId, entries);
};

export const buildSecretsUsage = (
  sources: readonly Source[],
  resolvers: SecretUsageResolvers,
): Effect.Effect<readonly SecretUsageEntry[], never> =>
  Effect.gen(function* () {
    const usageIndex = new Map<string, Map<string, SecretUsage>>();

    for (const source of sources) {
      if (!source.scopeId) continue;
      const resolve = resolvers[source.pluginId];
      if (!resolve) continue;

      const secretIds = yield* resolve(source.id, source.scopeId).pipe(
        Effect.catchAll(() => Effect.succeed([] as readonly string[])),
      );

      for (const secretId of secretIds) {
        addUsage(usageIndex, secretId, {
          sourceId: source.id,
          sourceName: source.name,
          sourceKind: source.kind,
        });
      }
    }

    return [...usageIndex.entries()]
      .map(([secretId, usedBy]) => ({
        secretId,
        usedBy: sortUsage([...usedBy.values()]),
      }))
      .sort((left, right) => left.secretId.localeCompare(right.secretId));
  });

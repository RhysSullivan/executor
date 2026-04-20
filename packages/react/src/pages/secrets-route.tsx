import { Result } from "@effect-atom/atom-react";

import type { SecretsPageSecret, SecretsPageUsage } from "./secrets";

export type SecretsListEntry = {
  readonly id: string;
  readonly name: string;
  readonly provider?: string;
};

export type SecretsUsageEntry = {
  readonly secretId: string;
  readonly usedBy: readonly SecretsPageUsage[];
};

export type SecretsRouteState = {
  readonly state: "loading" | "error" | "ready";
  readonly secrets: readonly SecretsPageSecret[];
};

export const mergeSecretsWithUsage = (
  secrets: readonly SecretsListEntry[],
  usageEntries: readonly SecretsUsageEntry[],
): readonly SecretsPageSecret[] => {
  const usageBySecretId = new Map(usageEntries.map((entry) => [entry.secretId, entry.usedBy]));
  return secrets.map((secret) => ({
    id: secret.id,
    name: secret.name,
    provider: secret.provider ? String(secret.provider) : undefined,
    usedBy: usageBySecretId.get(secret.id) ?? [],
  }));
};

export const resolveSecretsRouteState = (
  secrets: Result.Result<readonly SecretsListEntry[], unknown>,
  usage: Result.Result<readonly SecretsUsageEntry[], unknown>,
): SecretsRouteState =>
  Result.match(secrets, {
    onInitial: () => ({ state: "loading", secrets: [] as readonly SecretsPageSecret[] }),
    onFailure: () => ({ state: "error", secrets: [] as readonly SecretsPageSecret[] }),
    onSuccess: ({ value }) => ({
      state: "ready" as const,
      secrets: mergeSecretsWithUsage(value, Result.isSuccess(usage) ? usage.value : []),
    }),
  });

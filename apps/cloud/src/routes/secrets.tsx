import { createFileRoute } from "@tanstack/react-router";
import { Result, useAtomValue } from "@effect-atom/atom-react";
import { secretsAtom } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import {
  SecretsPage,
  type SecretsPageSecret,
} from "@executor/react/pages/secrets";
import { CloudApiClient } from "../web/client";

const secretsUsageAtom = (scopeId: ReturnType<typeof useScope>) =>
  CloudApiClient.query("secretsUsage", "list", {
    path: { scopeId },
    timeToLive: "30 seconds",
  });

const mergeSecrets = (
  secrets: readonly {
    readonly id: string;
    readonly name: string;
    readonly provider?: string;
  }[],
  usageEntries: readonly {
    readonly secretId: string;
    readonly usedBy: readonly {
      readonly sourceId: string;
      readonly sourceName: string;
      readonly sourceKind: string;
    }[];
  }[],
): readonly SecretsPageSecret[] => {
  const usageBySecretId = new Map(usageEntries.map((entry) => [entry.secretId, entry.usedBy]));
  return secrets.map((secret) => ({
    id: secret.id,
    name: secret.name,
    provider: secret.provider ? String(secret.provider) : undefined,
    usedBy: usageBySecretId.get(secret.id) ?? [],
  }));
};

type SecretsRouteState = {
  readonly state: "loading" | "error" | "ready";
  readonly secrets: readonly SecretsPageSecret[];
};

function CloudSecretsRoute() {
  const scopeId = useScope();
  const secrets = useAtomValue(secretsAtom(scopeId));
  const usage = useAtomValue(secretsUsageAtom(scopeId));

  const merged: SecretsRouteState = Result.match(secrets, {
    onInitial: () => ({ state: "loading", secrets: [] as readonly SecretsPageSecret[] }),
    onFailure: () => ({ state: "error", secrets: [] as readonly SecretsPageSecret[] }),
    onSuccess: ({ value }) =>
      Result.match(usage, {
        onInitial: () => ({ state: "loading", secrets: [] as readonly SecretsPageSecret[] }),
        onFailure: () => ({ state: "error", secrets: [] as readonly SecretsPageSecret[] }),
        onSuccess: ({ value: usageValue }) => ({
          state: "ready" as const,
          secrets: mergeSecrets(value, usageValue),
        }),
      }),
  });

  return (
    <SecretsPage
      secretProviderPlugins={[]}
      addSecretDescription="Store a credential or API key for this organization."
      showProviderInfo={false}
      storageOptions={[{ value: "workos-vault", label: "WorkOS Vault" }]}
      secretsLoadState={merged.state}
      secrets={merged.secrets}
    />
  );
}

export const Route = createFileRoute("/secrets")({
  component: CloudSecretsRoute,
});

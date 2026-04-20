import { createFileRoute } from "@tanstack/react-router";
import { useAtomValue } from "@effect-atom/atom-react";
import { secretsAtom } from "@executor/react/api/atoms";
import { ReactivityKey } from "@executor/react/api/reactivity-keys";
import { useScope } from "@executor/react/api/scope-context";
import { SecretsPage } from "@executor/react/pages/secrets";
import { resolveSecretsRouteState } from "@executor/react/pages/secrets-route";
import { CloudApiClient } from "../web/client";

const secretsUsageAtom = (scopeId: ReturnType<typeof useScope>) =>
  CloudApiClient.query("secretsUsage", "list", {
    path: { scopeId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.sources],
  });

function CloudSecretsRoute() {
  const scopeId = useScope();
  const secrets = useAtomValue(secretsAtom(scopeId));
  const usage = useAtomValue(secretsUsageAtom(scopeId));
  const merged = resolveSecretsRouteState(secrets, usage);

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

import { createFileRoute } from "@tanstack/react-router";
import { useAtomValue } from "@effect-atom/atom-react";
import { secretsAtom } from "@executor/react/api/atoms";
import { ReactivityKey } from "@executor/react/api/reactivity-keys";
import { useScope } from "@executor/react/api/scope-context";
import { SecretsPage } from "@executor/react/pages/secrets";
import { resolveSecretsRouteState } from "@executor/react/pages/secrets-route";
import { onePasswordSecretProviderPlugin } from "@executor/plugin-onepassword/react";
import { LocalApiClient } from "../web/client";

const secretProviderPlugins = [onePasswordSecretProviderPlugin];

const secretsUsageAtom = (scopeId: ReturnType<typeof useScope>) =>
  LocalApiClient.query("secretsUsage", "list", {
    path: { scopeId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.sources],
  });

function LocalSecretsRoute() {
  const scopeId = useScope();
  const secrets = useAtomValue(secretsAtom(scopeId));
  const usage = useAtomValue(secretsUsageAtom(scopeId));
  const merged = resolveSecretsRouteState(secrets, usage);

  return (
    <SecretsPage
      secretProviderPlugins={secretProviderPlugins}
      secretsLoadState={merged.state}
      secrets={merged.secrets}
    />
  );
}

export const Route = createFileRoute("/secrets")({
  component: LocalSecretsRoute,
});

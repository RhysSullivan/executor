import { createFileRoute } from "@tanstack/react-router";
import { SecretsPage } from "@executor/react/pages/secrets";

export const Route = createFileRoute("/secrets")({
  component: () => (
    <SecretsPage
      secretProviderPlugins={[]}
      addSecretDescription="Store a credential or API key for this organization."
      showProviderInfo={false}
      storageOptions={[{ value: "workos-vault", label: "WorkOS Vault" }]}
    />
  ),
});

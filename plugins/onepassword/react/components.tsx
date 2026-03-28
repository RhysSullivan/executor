import { useEffect, useState, type ReactNode } from "react";

import {
  getExecutorApiBaseUrl,
  useExecutorMutation,
  useWorkspaceRequestContext,
} from "@executor/react";
import type {
  SecretStoreCreateFormProps,
} from "@executor/react/plugins";
import {
  type OnePasswordDiscoverVaultsInput,
  type OnePasswordDiscoverVaultsResult,
  type OnePasswordStoreAuth,
  type OnePasswordVault,
} from "@executor/plugin-onepassword-shared";

const fieldClassName =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25";

const buttonClassName =
  "inline-flex h-9 items-center justify-center rounded-lg border border-input bg-card px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50";

const primaryButtonClassName =
  "inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50";

function FieldLabel(props: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-[12px] font-medium text-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

export function OnePasswordSecretStoreCreateForm(
  props: SecretStoreCreateFormProps,
) {
  const workspace = useWorkspaceRequestContext();
  const [name, setName] = useState("");
  const [authKind, setAuthKind] = useState<"desktop-app" | "service-account">(
    "desktop-app",
  );
  const [accountName, setAccountName] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [tokenSecretId, setTokenSecretId] = useState("");
  const [discoveredVaults, setDiscoveredVaults] = useState<ReadonlyArray<OnePasswordVault>>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const discoverVaultsMutation = useExecutorMutation<
    OnePasswordDiscoverVaultsInput,
    OnePasswordDiscoverVaultsResult
  >(async (payload) => {
    if (!workspace.enabled) {
      throw new Error("Workspace is still loading.");
    }

    const response = await fetch(
      `${getExecutorApiBaseUrl()}/v1/workspaces/${workspace.workspaceId}/plugins/onepassword/vaults/discover`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      let message = "Failed loading 1Password vaults.";
      try {
        const responseError = await response.json() as {
          message?: string;
          details?: string;
        };
        message = responseError.message ?? responseError.details ?? message;
      } catch {
        // ignore response parsing errors
      }
      throw new Error(message);
    }

    return await response.json() as OnePasswordDiscoverVaultsResult;
  });

  useEffect(() => {
    setDiscoveredVaults([]);
    discoverVaultsMutation.reset();
  }, [accountName, authKind, discoverVaultsMutation.reset, tokenSecretId]);

  const onePasswordAuth = (): OnePasswordStoreAuth | null => {
    if (authKind === "desktop-app") {
      const trimmedAccountName = accountName.trim();
      if (!trimmedAccountName) {
        return null;
      }

      return {
        kind: "desktop-app",
        accountName: trimmedAccountName,
      };
    }

    if (!tokenSecretId) {
      return null;
    }

    return {
      kind: "service-account",
      tokenSecretRef: {
        secretId: tokenSecretId as Extract<
          OnePasswordStoreAuth,
          { kind: "service-account" }
        >["tokenSecretRef"]["secretId"],
      },
    };
  };

  const handleDiscoverVaults = async () => {
    setError(null);

    const auth = onePasswordAuth();
    if (!auth) {
      setError(
        authKind === "desktop-app"
          ? "Enter your 1Password account name before loading vaults."
          : "Select a service-account token secret before loading vaults.",
      );
      return;
    }

    try {
      const result = await discoverVaultsMutation.mutateAsync({ auth });
      setDiscoveredVaults(result.vaults);
      if (!vaultId.trim() && result.vaults.length > 0) {
        setVaultId(result.vaults[0]!.id);
      }
      if (result.vaults.length === 0) {
        setError("No accessible vaults were returned for this 1Password account.");
      }
    } catch (cause) {
      setDiscoveredVaults([]);
      setError(
        cause instanceof Error ? cause.message : "Failed loading 1Password vaults.",
      );
    }
  };

  const handleSubmit = async () => {
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Store name is required.");
      return;
    }
    if (authKind === "desktop-app" && !accountName.trim()) {
      setError("Account name is required for desktop app auth.");
      return;
    }
    if (!vaultId.trim()) {
      setError("Vault ID is required.");
      return;
    }
    if (authKind === "service-account" && !tokenSecretId) {
      setError("Select a secret that contains the 1Password service account token.");
      return;
    }

    try {
      await props.onSubmit({
        name: trimmedName,
        config: {
          vaultId: vaultId.trim(),
          auth: onePasswordAuth()!,
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed creating secret store.",
      );
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-[13px] text-destructive">
          {error}
        </div>
      )}

      <FieldLabel label="Name">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Team 1Password"
          className={fieldClassName}
          autoFocus
        />
      </FieldLabel>

      <div className="grid gap-4 sm:grid-cols-2">
        <FieldLabel label="Auth method">
          <select
            value={authKind}
            onChange={(event) =>
              setAuthKind(event.target.value as "desktop-app" | "service-account")}
            className={fieldClassName}
          >
            <option value="desktop-app">Desktop app</option>
            <option value="service-account">Service account</option>
          </select>
        </FieldLabel>
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => {
              void handleDiscoverVaults();
            }}
            disabled={discoverVaultsMutation.status === "pending"}
            className={buttonClassName}
          >
            {discoverVaultsMutation.status === "pending" ? "Loading..." : "Load vaults"}
          </button>
        </div>
      </div>

      {authKind === "desktop-app" ? (
        <FieldLabel label="Account name or UUID">
          <input
            value={accountName}
            onChange={(event) => setAccountName(event.target.value)}
            placeholder="my.1password.com"
            className={fieldClassName}
          />
          <div className="text-[11px] text-muted-foreground">
            Use the account shown in the 1Password desktop app sidebar or the
            account UUID from <code>op account list --format json</code>.
          </div>
        </FieldLabel>
      ) : (
        <FieldLabel label="Service Account Token Secret">
          <select
            value={tokenSecretId}
            onChange={(event) => setTokenSecretId(event.target.value)}
            className={fieldClassName}
          >
            <option value="">
              {props.secrets.status === "ready"
                ? "Select a secret"
                : "Secrets are loading"}
            </option>
            {props.secrets.status === "ready" &&
              props.secrets.data.map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {secret.name ?? secret.id}
                </option>
              ))}
          </select>
          <div className="text-[11px] text-muted-foreground">
            Use this for remote or headless automation. Desktop app auth is better for
            local Executor use.
          </div>
        </FieldLabel>
      )}

      {discoveredVaults.length > 0 && (
        <FieldLabel label="Discovered vaults">
          <select
            value={vaultId}
            onChange={(event) => setVaultId(event.target.value)}
            className={fieldClassName}
          >
            {discoveredVaults.map((vault) => (
              <option key={vault.id} value={vault.id}>
                {vault.name}
              </option>
            ))}
          </select>
          <div className="text-[11px] text-muted-foreground">
            Pick from the vaults visible to this account, or override the id below.
          </div>
        </FieldLabel>
      )}

      <FieldLabel label="Vault ID">
        <input
          value={vaultId}
          onChange={(event) => setVaultId(event.target.value)}
          placeholder="vlt_..."
          className={`${fieldClassName} font-mono text-[12px]`}
        />
      </FieldLabel>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={props.onCancel}
          className={buttonClassName}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={props.isSubmitting}
          className={primaryButtonClassName}
        >
          {props.isSubmitting ? "Creating..." : "Create store"}
        </button>
      </div>
    </div>
  );
}

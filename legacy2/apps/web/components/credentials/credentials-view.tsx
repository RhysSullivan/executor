"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  useAtomSet,
  useAtomValue,
} from "@effect-atom/atom-react";

import { useWorkspace } from "../../lib/hooks/use-workspace";
import {
  credentialBindingsByWorkspace,
  removeCredentialBinding,
  toCredentialBindingRemoveRequest,
  toCredentialBindingRemoveResult,
  toCredentialBindingUpsertRequest,
  toCredentialBindingUpsertPayload,
  upsertCredentialBinding,
} from "../../lib/control-plane/atoms";
import type {
  CredentialProvider,
  CredentialScopeType,
  SourceCredentialBinding,
} from "@executor-v2/schema";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { matchState } from "../shared/match-state";
import { PageHeader } from "../shared/page-header";
import { StatusMessage } from "../shared/status-message";
import { cn, createLocalId } from "../../lib/utils";

const providerOptions: ReadonlyArray<CredentialProvider> = [
  "api_key",
  "bearer",
  "oauth2",
  "custom",
];

const scopeTypeOptions: ReadonlyArray<CredentialScopeType> = [
  "workspace",
  "organization",
  "account",
];

export function CredentialsView() {
  const { workspaceId } = useWorkspace();

  const credentialBindingsState = useAtomValue(credentialBindingsByWorkspace(workspaceId));
  const runUpsertCredentialBinding = useAtomSet(upsertCredentialBinding, {
    mode: "promise",
  });
  const runRemoveCredentialBinding = useAtomSet(removeCredentialBinding, {
    mode: "promise",
  });

  const [credentialSourceKey, setCredentialSourceKey] = useState("");
  const [credentialProvider, setCredentialProvider] = useState<CredentialProvider>(
    "api_key",
  );
  const [credentialScopeType, setCredentialScopeType] =
    useState<CredentialScopeType>("workspace");
  const [credentialIdInput, setCredentialIdInput] = useState("");
  const [credentialSecretValue, setCredentialSecretValue] = useState("");
  const [credentialAccountId, setCredentialAccountId] = useState("");
  const [credentialAdditionalHeadersJson, setCredentialAdditionalHeadersJson] =
    useState("");
  const [credentialBoundAuthFingerprint, setCredentialBoundAuthFingerprint] =
    useState("");

  const [credentialEditingId, setCredentialEditingId] = useState<
    SourceCredentialBinding["id"] | null
  >(null);
  const [credentialSearchQuery, setCredentialSearchQuery] = useState("");

  const [credentialStatusText, setCredentialStatusText] = useState<string | null>(
    null,
  );
  const [credentialStatusIsError, setCredentialStatusIsError] = useState(false);

  const [credentialBusyId, setCredentialBusyId] =
    useState<SourceCredentialBinding["id"] | null>(null);

  const filteredCredentialBindings = useMemo(() => {
    const query = credentialSearchQuery.trim().toLowerCase();
    if (query.length === 0) {
      return credentialBindingsState.items;
    }

    return credentialBindingsState.items.filter((binding) => {
      return (
        binding.sourceKey.toLowerCase().includes(query) ||
        binding.provider.toLowerCase().includes(query) ||
        binding.scopeType.toLowerCase().includes(query) ||
        binding.credentialId.toLowerCase().includes(query) ||
        (binding.accountId ?? "").toLowerCase().includes(query)
      );
    });
  }, [credentialBindingsState.items, credentialSearchQuery]);

  const setInfoStatus = (message: string) => {
    setCredentialStatusIsError(false);
    setCredentialStatusText(message);
  };

  const setErrorStatus = (message: string) => {
    setCredentialStatusIsError(true);
    setCredentialStatusText(message);
  };

  const resetCredentialForm = () => {
    setCredentialEditingId(null);
    setCredentialSourceKey("");
    setCredentialProvider("api_key");
    setCredentialScopeType("workspace");
    setCredentialIdInput("");
    setCredentialSecretValue("");
    setCredentialAccountId("");
    setCredentialAdditionalHeadersJson("");
    setCredentialBoundAuthFingerprint("");
  };

  const handleEditCredential = (credentialBindingId: SourceCredentialBinding["id"]) => {
    const binding = credentialBindingsState.items.find((item) => item.id === credentialBindingId);
    if (!binding) {
      setErrorStatus("Unable to load selected credential binding.");
      return;
    }

    setCredentialEditingId(binding.id);
    setCredentialSourceKey(binding.sourceKey);
    setCredentialProvider(binding.provider);
    setCredentialScopeType(binding.scopeType);
    setCredentialIdInput(binding.credentialId);
    setCredentialSecretValue("");
    setCredentialAccountId(binding.accountId ?? "");
    setCredentialAdditionalHeadersJson(binding.additionalHeadersJson ?? "");
    setCredentialBoundAuthFingerprint(binding.boundAuthFingerprint ?? "");
    setInfoStatus(`Loaded binding ${binding.sourceKey} for editing. Enter a new secret to rotate credentials.`);
  };

  const handleCancelCredentialEdit = () => {
    resetCredentialForm();
    setInfoStatus("Credential edit cancelled.");
  };

  const handleUpsertCredential = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (credentialBusyId !== null) {
      return;
    }

    const sourceKey = credentialSourceKey.trim();
    const credentialId = credentialIdInput.trim();
    const secret = credentialSecretValue.trim();
    const accountId = credentialAccountId.trim();
    const additionalHeadersJson = credentialAdditionalHeadersJson.trim();
    const boundAuthFingerprint = credentialBoundAuthFingerprint.trim();

    if (sourceKey.length === 0 || credentialId.length === 0 || secret.length === 0) {
      setErrorStatus("Source key, credential id, and secret are required.");
      return;
    }

    if (credentialScopeType === "account" && accountId.length === 0) {
      setErrorStatus("Account scope credentials require account id.");
      return;
    }

    const requestId =
      credentialEditingId ??
      (createLocalId("auth_binding_") as SourceCredentialBinding["id"]);

    setCredentialBusyId(requestId);

    void runUpsertCredentialBinding(toCredentialBindingUpsertRequest({
      workspaceId,
      payload: toCredentialBindingUpsertPayload({
        id: credentialEditingId ?? undefined,
        credentialId: credentialId as SourceCredentialBinding["credentialId"],
        scopeType: credentialScopeType,
        sourceKey,
        provider: credentialProvider,
        secret,
        accountId:
          credentialScopeType === "account"
            ? (accountId as SourceCredentialBinding["accountId"])
            : null,
        additionalHeadersJson: additionalHeadersJson.length > 0 ? additionalHeadersJson : null,
        boundAuthFingerprint: boundAuthFingerprint.length > 0 ? boundAuthFingerprint : null,
      }),
    }))
      .then(() => {
        setInfoStatus(
          credentialEditingId
            ? `Updated credential binding ${sourceKey}.`
            : `Added credential binding ${sourceKey}.`,
        );
        resetCredentialForm();
      })
      .catch(() => {
        setErrorStatus("Credential save failed.");
      })
      .finally(() => {
        setCredentialBusyId(null);
      });
  };

  const handleRemoveCredential = (credentialBindingId: SourceCredentialBinding["id"]) => {
    if (credentialBusyId !== null) {
      return;
    }

    setCredentialBusyId(credentialBindingId);

    void runRemoveCredentialBinding(
      toCredentialBindingRemoveRequest({ workspaceId, credentialBindingId }),
    )
      .then((result) => {
        const removed = toCredentialBindingRemoveResult(result);
        setInfoStatus(
          removed ? "Credential binding removed." : "Credential binding not found.",
        );

        if (credentialEditingId === credentialBindingId) {
          handleCancelCredentialEdit();
        }

      })
      .catch(() => {
        setErrorStatus("Credential removal failed.");
      })
      .finally(() => {
        setCredentialBusyId(null);
      });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <PageHeader
            title={
              credentialEditingId ? "Edit Credential Binding" : "Add Credential Binding"
            }
            description="Bind workspace credentials to sources and providers."
          />
        </CardHeader>
        <CardContent className="space-y-4">
          <form className="space-y-3" onSubmit={handleUpsertCredential}>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="credential-source-key">
                Source key
              </label>
                <Input
                  id="credential-source-key"
                  value={credentialSourceKey}
                  onChange={(event) => setCredentialSourceKey(event.target.value)}
                  placeholder="source:src_github"
                  required
                  disabled={credentialBusyId !== null}
                />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="credential-provider">
                  Provider
                </label>
                <Select
                  id="credential-provider"
                  value={credentialProvider}
                  onChange={(event) =>
                    setCredentialProvider(event.target.value as CredentialProvider)
                  }
                  disabled={credentialBusyId !== null}
                >
                  {providerOptions.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="grid gap-1.5">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor="credential-scope-type"
                >
                  Scope
                </label>
                <Select
                  id="credential-scope-type"
                  value={credentialScopeType}
                  onChange={(event) =>
                    setCredentialScopeType(event.target.value as CredentialScopeType)
                  }
                  disabled={credentialBusyId !== null}
                >
                  {scopeTypeOptions.map((scopeType) => (
                    <option key={scopeType} value={scopeType}>
                      {scopeType}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="credential-id">
                  Credential id
                </label>
                <Input
                  id="credential-id"
                  value={credentialIdInput}
                  onChange={(event) => setCredentialIdInput(event.target.value)}
                  placeholder="conn_123"
                  required
                  disabled={credentialBusyId !== null}
                />
              </div>

              <div className="grid gap-1.5">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor="credential-secret"
                >
                  Secret
                </label>
                <Input
                  id="credential-secret"
                  value={credentialSecretValue}
                  onChange={(event) => setCredentialSecretValue(event.target.value)}
                  placeholder="Paste secret value"
                  required
                  disabled={credentialBusyId !== null}
                />
              </div>
            </div>

            {credentialScopeType === "account" ? (
              <div className="grid gap-1.5">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor="credential-account-id"
                >
                  Account id
                </label>
                <Input
                  id="credential-account-id"
                  value={credentialAccountId}
                  onChange={(event) => setCredentialAccountId(event.target.value)}
                  placeholder="acct_123"
                  required
                  disabled={credentialBusyId !== null}
                />
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="credential-headers-json"
              >
                Additional headers JSON (optional)
              </label>
              <Input
                id="credential-headers-json"
                value={credentialAdditionalHeadersJson}
                onChange={(event) =>
                  setCredentialAdditionalHeadersJson(event.target.value)
                }
                placeholder='{"X-Team": "tools"}'
                disabled={credentialBusyId !== null}
              />
            </div>

            <div className="grid gap-1.5">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="credential-auth-fingerprint"
              >
                Bound auth fingerprint (optional)
              </label>
              <Input
                id="credential-auth-fingerprint"
                value={credentialBoundAuthFingerprint}
                onChange={(event) =>
                  setCredentialBoundAuthFingerprint(event.target.value)
                }
                placeholder="fingerprint hash"
                disabled={credentialBusyId !== null}
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="submit" disabled={credentialBusyId !== null}>
                {credentialBusyId !== null
                  ? "Saving..."
                  : credentialEditingId
                  ? "Save Binding"
                  : "Add Binding"}
              </Button>
              {credentialEditingId ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCancelCredentialEdit}
                  disabled={credentialBusyId !== null}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>

          <StatusMessage
            message={credentialStatusText}
            variant={credentialStatusIsError ? "error" : "info"}
          />
        </CardContent>
      </Card>

      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <PageHeader
            title="Credential Bindings"
            description="Credentials currently linked to sources."
          />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="credential-search">
              Search
            </label>
            <Input
              id="credential-search"
              value={credentialSearchQuery}
              onChange={(event) => setCredentialSearchQuery(event.target.value)}
              placeholder="source key, provider, scope, credential id"
              disabled={credentialBindingsState.state === "loading"}
            />
          </div>

          {matchState(credentialBindingsState, {
            loading: "Loading credential bindings...",
            empty:
              credentialSearchQuery.trim().length > 0
                ? "No credentials match this search."
                : "No credential bindings found.",
            filteredCount: filteredCredentialBindings.length,
            ready: () => (
              <div className="space-y-2">
                {filteredCredentialBindings.map((binding) => {
                  const isBusy = credentialBusyId === binding.id;

                  return (
                    <div
                      key={binding.id}
                      className={cn(
                        "rounded-lg border border-border bg-background/70 p-3",
                        isBusy && "opacity-75",
                      )}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-1">
                          <p className="truncate text-sm font-medium">{binding.sourceKey}</p>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <Badge variant="outline">{binding.provider}</Badge>
                            <Badge variant="outline">{binding.scopeType}</Badge>
                            <span>{binding.credentialId}</span>
                          </div>
                          <p className="break-all text-xs text-muted-foreground">
                            secret {binding.hasSecret ? "configured" : "missing"}
                          </p>
                          {binding.accountId ? (
                            <p className="break-all text-xs text-muted-foreground">
                              account {binding.accountId}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleEditCredential(binding.id)}
                            disabled={credentialBusyId !== null}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            onClick={() => handleRemoveCredential(binding.id)}
                            disabled={credentialBusyId !== null}
                          >
                            {isBusy ? "Working..." : "Remove"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ),
          })}
        </CardContent>
      </Card>
    </div>
  );
}

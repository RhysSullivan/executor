import {
  useAtomSet,
} from "@effect-atom/atom-react";
import type {
  BrowseSecretStoreResult,
  CreateSecretResult,
  SecretListItem,
} from "@executor/platform-api";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getExecutorApiHttpClient,
} from "../core/http-client";
import {
  useCreateSecret,
  useRefreshSecrets,
  useSecrets,
  useSecretStores,
} from "../hooks/secrets";
import {
  useExecutorMutation,
} from "../hooks/mutations";

type SecretReferenceFieldProps = {
  label: string;
  value: string;
  emptyLabel: string;
  draftNamePlaceholder: string;
  draftValuePlaceholder: string;
  onChange: (value: string) => void;
};

type BrowserEntry = BrowseSecretStoreResult["entries"][number];
type RemoteSecretEntry = {
  kind: "remote";
  storeId: string;
  storeName: string;
  entry: BrowserEntry;
};
type ManagedSecretEntry = {
  kind: "managed";
  secret: SecretListItem;
};
type UnifiedSecretEntry = ManagedSecretEntry | RemoteSecretEntry;

const buttonClassName =
  "inline-flex h-8 items-center justify-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50";

export function SecretReferenceField(props: SecretReferenceFieldProps) {
  const secrets = useSecrets();
  const secretStores = useSecretStores();
  const refreshSecrets = useRefreshSecrets();
  const createSecret = useCreateSecret();
  const browseSecretStoreMutation = useAtomSet(
    getExecutorApiHttpClient().mutation("local", "browseSecretStore"),
    { mode: "promise" },
  );
  const importSecretFromStoreMutation = useAtomSet(
    getExecutorApiHttpClient().mutation("local", "importSecretFromStore"),
    { mode: "promise" },
  );
  const [draftName, setDraftName] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showFinder, setShowFinder] = useState(false);
  const [finderQuery, setFinderQuery] = useState("");
  const [finderRemoteEntries, setFinderRemoteEntries] = useState<
    ReadonlyArray<RemoteSecretEntry>
  >([]);
  const [finderError, setFinderError] = useState<string | null>(null);
  const [finderStatus, setFinderStatus] = useState<"idle" | "pending">("idle");

  const browseSecretStore = useCallback(
    async (input: {
      storeId: string;
      query?: string | null;
    }) =>
      browseSecretStoreMutation({
        path: {
          storeId: input.storeId,
        },
        payload: {
          ...(input.query?.trim() ? { query: input.query.trim() } : {}),
        },
      }),
    [browseSecretStoreMutation],
  );

  const importSecretFromStore = useCallback(
    async (input: {
      storeId: string;
      selectionKey: string;
    }) =>
      importSecretFromStoreMutation({
        path: {
          storeId: input.storeId,
        },
        payload: {
          selectionKey: input.selectionKey,
        },
      }),
    [importSecretFromStoreMutation],
  );

  const importMutation = useExecutorMutation<
    { storeId: string; selectionKey: string },
    CreateSecretResult
  >(importSecretFromStore);

  const browsableStores = useMemo(
    () =>
      secretStores.status === "ready"
        ? secretStores.data.filter((store) =>
            store.capabilities.canBrowseSecrets
            && store.capabilities.canImportSecrets
          )
        : [],
    [secretStores],
  );

  const selectedSecretId = useMemo(() => {
    if (!props.value) {
      return null;
    }

    try {
      const parsed = JSON.parse(props.value) as { secretId?: string };
      return typeof parsed.secretId === "string" ? parsed.secretId : null;
    } catch {
      return null;
    }
  }, [props.value]);

  const selectedSecret = useMemo(
    () =>
      secrets.status === "ready" && selectedSecretId
        ? secrets.data.find((secret) => secret.id === selectedSecretId) ?? null
        : null,
    [secrets, selectedSecretId],
  );

  const filteredManagedSecrets = useMemo(() => {
    if (secrets.status !== "ready") {
      return [] as ReadonlyArray<SecretListItem>;
    }

    const normalizedQuery = finderQuery.trim().toLowerCase();
    return secrets.data.filter((secret) =>
      normalizedQuery.length === 0
      || (secret.name ?? "").toLowerCase().includes(normalizedQuery)
      || secret.id.toLowerCase().includes(normalizedQuery)
      || secret.storeName.toLowerCase().includes(normalizedQuery)
      || secret.storeKind.toLowerCase().includes(normalizedQuery)
    );
  }, [finderQuery, secrets]);

  const unifiedEntries = useMemo(() => {
    const managedEntries: ReadonlyArray<UnifiedSecretEntry> = filteredManagedSecrets.map(
      (secret) => ({
        kind: "managed" as const,
        secret,
      }),
    );

    return [
      ...managedEntries,
      ...finderRemoteEntries,
    ] satisfies ReadonlyArray<UnifiedSecretEntry>;
  }, [filteredManagedSecrets, finderRemoteEntries]);

  useEffect(() => {
    if (!showFinder) {
      return;
    }

    if (browsableStores.length === 0) {
      setFinderRemoteEntries([]);
      setFinderStatus("idle");
      return;
    }

    let active = true;
    setFinderStatus("pending");
    const timeout = window.setTimeout(() => {
      void Promise.all(
        browsableStores.map(async (store) => {
          const result = await browseSecretStore({
            storeId: store.id,
            query: finderQuery,
          });
          return result.entries
            .filter((entry) => entry.kind === "secret")
            .map((entry) => ({
              kind: "remote" as const,
              storeId: store.id,
              storeName: store.name,
              entry,
            }));
        }),
      ).then((results) => {
        if (!active) {
          return;
        }
        setFinderRemoteEntries(
          results
            .flat()
            .sort((left, right) =>
              left.entry.label.localeCompare(right.entry.label)
            ),
        );
        setFinderError(null);
        setFinderStatus("idle");
      }).catch((cause) => {
        if (!active) {
          return;
        }
        setFinderRemoteEntries([]);
        setFinderError(
          cause instanceof Error ? cause.message : "Failed loading connected secrets.",
        );
        setFinderStatus("idle");
      });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [browsableStores, browseSecretStore, finderQuery, showFinder]);

  const handleCreate = async () => {
    const trimmedName = draftName.trim();
    if (!trimmedName) {
      setCreateError("Secret name is required.");
      return;
    }
    if (!draftValue.trim()) {
      setCreateError("Secret value is required.");
      return;
    }

    try {
      setCreateError(null);
      const created = await createSecret.mutateAsync({
        name: trimmedName,
        value: draftValue,
      });
      props.onChange(JSON.stringify({
        secretId: created.id,
      }));
      setDraftName("");
      setDraftValue("");
      setShowCreate(false);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Failed creating secret.");
    }
  };

  const handleSelectManagedSecret = (secret: SecretListItem) => {
    props.onChange(JSON.stringify({
      secretId: secret.id,
    }));
    setShowFinder(false);
    setFinderQuery("");
    setFinderError(null);
  };

  const handleSelectRemoteSecret = async (entry: RemoteSecretEntry) => {
    try {
      const created = await importMutation.mutateAsync({
        storeId: entry.storeId,
        selectionKey: entry.entry.key,
      });
      refreshSecrets();
      props.onChange(JSON.stringify({
        secretId: created.id,
      }));
      setShowFinder(false);
      setFinderQuery("");
      setFinderError(null);
    } catch (cause) {
      setFinderError(
        cause instanceof Error ? cause.message : "Failed linking secret.",
      );
    }
  };

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">{props.label}</span>

      <button
        type="button"
        onClick={() => {
          setShowCreate(false);
          setShowFinder((current) => !current);
        }}
        className="flex min-h-9 w-full items-center justify-between gap-3 rounded-lg border border-input bg-background px-3 py-2 text-left text-sm text-foreground outline-none transition-colors hover:bg-accent/30 focus:border-ring focus:ring-1 focus:ring-ring/25"
      >
        <div className="min-w-0">
          <div className="truncate">
            {selectedSecret
              ? (selectedSecret.name ?? selectedSecret.id)
              : props.emptyLabel}
          </div>
          {selectedSecret && (
            <div className="truncate text-[11px] text-muted-foreground">
              {selectedSecret.storeName} · {selectedSecret.storeKind}
            </div>
          )}
        </div>
        <div className="shrink-0 text-[11px] font-medium text-muted-foreground">
          {showFinder ? "Close" : "Choose"}
        </div>
      </button>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setShowFinder(false);
            setShowCreate((current) => !current);
          }}
          className={buttonClassName}
        >
          {showCreate ? "Hide create" : "Create new secret"}
        </button>
      </div>

      {showFinder && (
        <div className="space-y-3 border-l-2 border-border pl-4">
          <input
            value={finderQuery}
            onChange={(event) => setFinderQuery(event.target.value)}
            placeholder="Search all secrets"
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            autoFocus
          />

          {finderError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
              {finderError}
            </div>
          )}

          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {finderStatus === "pending" && (
              <div className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
                Loading secrets...
              </div>
            )}

            {finderStatus !== "pending" && unifiedEntries.length === 0 && !finderError && (
              <div className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
                No secrets matched.
              </div>
            )}

            {finderStatus !== "pending" && unifiedEntries.map((entry) => (
              entry.kind === "managed" ? (
                <button
                  key={`managed:${entry.secret.id}`}
                  type="button"
                  onClick={() => handleSelectManagedSecret(entry.secret)}
                  className="flex w-full items-start justify-between gap-3 rounded-lg border border-input bg-background px-3 py-2 text-left transition-colors hover:bg-accent/40"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-foreground">
                      {entry.secret.name ?? entry.secret.id}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {entry.secret.storeName} · managed
                    </div>
                  </div>
                  <div className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                    Use
                  </div>
                </button>
              ) : (
                <button
                  key={`remote:${entry.storeId}:${entry.entry.key}`}
                  type="button"
                  onClick={() => {
                    void handleSelectRemoteSecret(entry);
                  }}
                  className="flex w-full items-start justify-between gap-3 rounded-lg border border-input bg-background px-3 py-2 text-left transition-colors hover:bg-accent/40"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-foreground">
                      {entry.entry.label}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {entry.storeName}
                      {entry.entry.description ? ` · ${entry.entry.description}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {importMutation.status === "pending" ? "Linking" : "Link"}
                  </div>
                </button>
              )
            ))}
          </div>
        </div>
      )}

      {showCreate && (
        <div className="space-y-3 border-l-2 border-border pl-4">
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder={props.draftNamePlaceholder}
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
          <textarea
            value={draftValue}
            onChange={(event) => setDraftValue(event.target.value)}
            rows={3}
            placeholder={props.draftValuePlaceholder}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
          {createError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
              {createError}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                setCreateError(null);
              }}
              className={buttonClassName}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                void handleCreate();
              }}
              className={buttonClassName}
            >
              {createSecret.status === "pending" ? "Creating..." : "Save secret"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

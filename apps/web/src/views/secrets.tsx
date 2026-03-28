import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  type BrowseSecretStoreResult,
  getExecutorApiBaseUrl,
  type InstanceConfig,
  type Loadable,
  type SecretListItem,
  type SecretStore,
  useCreateSecret,
  useCreateSecretStore,
  useDeleteSecret,
  useDeleteSecretStore,
  useExecutorMutation,
  useInstanceConfig,
  useRefreshSecrets,
  useSecretStores,
  useSecrets,
  useUpdateSecret,
} from "@executor/react";

import { LoadableBlock } from "../components/loadable";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  IconPencil,
  IconPlus,
  IconSpinner,
  IconTrash,
} from "../components/icons";
import { cn } from "../lib/utils";
import { getSecretStoreFrontendPlugin } from "../plugins";

const creatableStorePluginsFromConfig = (config: Loadable<InstanceConfig>) =>
  config.status === "ready"
    ? config.data.secretStorePlugins.filter((plugin) => plugin.canCreate)
    : [];

const canManageStoreKind = (
  config: Loadable<InstanceConfig>,
  kind: string,
): boolean =>
  config.status === "ready"
    ? config.data.secretStorePlugins.some((plugin) =>
        plugin.kind === kind && plugin.canCreate
      )
    : false;

const defaultStoreLabel = (
  config: Loadable<InstanceConfig>,
  stores: Loadable<ReadonlyArray<SecretStore>>,
): string | null => {
  if (
    config.status !== "ready"
    || stores.status !== "ready"
    || config.data.defaultSecretStoreId === null
  ) {
    return null;
  }

  return stores.data.find((store) =>
    store.id === config.data.defaultSecretStoreId
  )?.name ?? null;
};

type SecretStoreBrowserEntry = BrowseSecretStoreResult["entries"][number];
type SecretStoreBrowserCrumb = {
  key: string;
  label: string;
};

const canBrowseAndImportStore = (store: SecretStore | null): boolean =>
  store?.capabilities.canBrowseSecrets === true
  && store.capabilities.canImportSecrets === true;

export function SecretsPage() {
  const instanceConfig = useInstanceConfig();
  const secretStores = useSecretStores();
  const secrets = useSecrets();
  const [showCreateStore, setShowCreateStore] = useState(false);
  const [showCreateSecret, setShowCreateSecret] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const creatableStorePlugins = creatableStorePluginsFromConfig(instanceConfig);
  const defaultLabel = defaultStoreLabel(instanceConfig, secretStores);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-10 lg:px-10 lg:py-14">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
              Secrets
            </h1>
            <p className="mt-1.5 text-[14px] text-muted-foreground">
              Manage secret stores and the secrets linked into sources.
              {defaultLabel ? ` New secrets default to ${defaultLabel}.` : ""}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setShowCreateStore(true);
              }}
              disabled={creatableStorePlugins.length === 0}
            >
              <IconPlus className="size-3.5" />
              Add store
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setShowCreateSecret(true);
                setEditingId(null);
              }}
            >
              <IconPlus className="size-3.5" />
              Add secret
            </Button>
          </div>
        </div>

        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Stores</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Local and external backends that hold managed secrets.
            </p>
          </div>

          {showCreateStore && (
            <CreateSecretStoreForm
              className="mb-2"
              onClose={() => setShowCreateStore(false)}
              pluginOptions={creatableStorePlugins}
              secrets={secrets}
            />
          )}

          <LoadableBlock loadable={secretStores} loading="Loading stores...">
            {(items) =>
              items.length === 0 ? (
                <SectionEmptyState
                  title="No secret stores yet"
                  description="Add a store to connect an external backend like 1Password."
                />
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {items.map((store) => (
                    <SecretStoreCard
                      key={store.id}
                      store={store}
                      canManage={canManageStoreKind(instanceConfig, store.kind)}
                    />
                  ))}
                </div>
              )
            }
          </LoadableBlock>
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Managed Secrets</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Secret records stay stable even if their underlying store handle changes.
            </p>
          </div>

          {showCreateSecret && (
            <CreateSecretForm
              className="mb-2"
              onClose={() => setShowCreateSecret(false)}
              storeOptions={secretStores.status === "ready" ? secretStores.data : []}
              defaultStoreId={
                instanceConfig.status === "ready"
                  ? instanceConfig.data.defaultSecretStoreId
                  : null
              }
            />
          )}

          <LoadableBlock loadable={secrets} loading="Loading secrets...">
            {(items) =>
              items.length === 0 && !showCreateSecret ? (
                <SectionEmptyState
                  title="No secrets stored"
                  description="Add a secret to use it in source authentication and runtime resolution."
                  actionLabel="Add secret"
                  onAction={() => {
                    setShowCreateSecret(true);
                    setEditingId(null);
                  }}
                />
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-card/80">
                  {items.map((secret, index) => (
                    <div
                      key={secret.id}
                      className={cn(
                        "px-5 py-3.5",
                        index > 0 && "border-t border-border",
                      )}
                    >
                      <SecretRow
                        secret={secret}
                        isEditing={editingId === secret.id}
                        onEdit={() =>
                          setEditingId(editingId === secret.id ? null : secret.id)}
                        onCancelEdit={() => setEditingId(null)}
                      />
                    </div>
                  ))}
                </div>
              )
            }
          </LoadableBlock>
        </section>
      </div>
    </div>
  );
}

function CreateSecretStoreForm(props: {
  className?: string;
  onClose: () => void;
  pluginOptions: ReadonlyArray<{
    kind: string;
    displayName: string;
    canCreate: boolean;
  }>;
  secrets: Loadable<ReadonlyArray<SecretListItem>>;
}) {
  const createSecretStore = useCreateSecretStore();
  const [kind, setKind] = useState(props.pluginOptions[0]?.kind ?? "");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectedFrontendPlugin = getSecretStoreFrontendPlugin(kind);
  const StoreCreateForm = selectedFrontendPlugin?.secretStore?.CreateStoreForm;

  useEffect(() => {
    if (kind.length > 0 || props.pluginOptions.length === 0) {
      return;
    }
    setKind(props.pluginOptions[0]!.kind);
  }, [kind, props.pluginOptions]);

  const handleSubmit = async () => {
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Store name is required.");
      return;
    }

    try {
      await createSecretStore.mutateAsync({
        kind,
        name: trimmedName,
        config: {},
      });
      props.onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed creating secret store.",
      );
    }
  };

  return (
    <FormCard
      className={props.className}
      title="New secret store"
      onClose={props.onClose}
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {props.pluginOptions.length === 0 ? (
        <div className="rounded-lg border border-border bg-background/40 px-4 py-3 text-[13px] text-muted-foreground">
          No external secret store plugins are available in this runtime.
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldLabel label="Store type">
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
              >
                {props.pluginOptions.map((plugin) => (
                  <option key={plugin.kind} value={plugin.kind}>
                    {plugin.displayName}
                  </option>
                ))}
              </select>
            </FieldLabel>
            {!StoreCreateForm && (
              <FieldLabel label="Name">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Secret store"
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
                  autoFocus
                />
              </FieldLabel>
            )}
          </div>

          {StoreCreateForm ? (
            <StoreCreateForm
              isSubmitting={createSecretStore.status === "pending"}
              onCancel={props.onClose}
              onSubmit={async (input) => {
                await createSecretStore.mutateAsync({
                  kind,
                  name: input.name,
                  config: input.config,
                });
                props.onClose();
              }}
              secrets={props.secrets}
            />
          ) : (
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={createSecretStore.status === "pending"}
              >
                {createSecretStore.status === "pending"
                  ? <IconSpinner className="size-3.5" />
                  : <IconPlus className="size-3.5" />}
                Create store
              </Button>
            </div>
          )}
        </>
      )}
    </FormCard>
  );
}

function CreateSecretForm(props: {
  className?: string;
  onClose: () => void;
  storeOptions: ReadonlyArray<SecretStore>;
  defaultStoreId: string | null;
}) {
  const createSecret = useCreateSecret();
  const refreshSecrets = useRefreshSecrets();
  const [mode, setMode] = useState<"create" | "import">("create");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [storeId, setStoreId] = useState(props.defaultStoreId ?? "");
  const [browserStack, setBrowserStack] = useState<ReadonlyArray<SecretStoreBrowserCrumb>>(
    [],
  );
  const [browserQuery, setBrowserQuery] = useState("");
  const [browserEntries, setBrowserEntries] = useState<
    ReadonlyArray<SecretStoreBrowserEntry>
  >([]);
  const [browserStatus, setBrowserStatus] = useState<"idle" | "pending">("idle");
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [selectedImportKey, setSelectedImportKey] = useState("");
  const [selectedImportLabel, setSelectedImportLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectedStore = props.storeOptions.find((store) => store.id === storeId) ?? null;
  const canImportSecrets = canBrowseAndImportStore(selectedStore);
  const canCreateSecrets = selectedStore?.capabilities.canCreateSecrets !== false;
  const currentParentKey = browserStack[browserStack.length - 1]?.key ?? null;

  const browseStore = useCallback(
    async (input: {
      storeId: string;
      parentKey?: string | null;
      query?: string | null;
    }) => {
      const response = await fetch(
        `${getExecutorApiBaseUrl()}/v1/local/secret-stores/${input.storeId}/browse`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...(input.parentKey ? { parentKey: input.parentKey } : {}),
            ...(input.query?.trim() ? { query: input.query.trim() } : {}),
          }),
        },
      );

      if (!response.ok) {
        let message = "Failed browsing secret store.";
        try {
          const payload = await response.json() as {
            message?: string;
            details?: string;
          };
          message = payload.message ?? payload.details ?? message;
        } catch {
          // ignore response parsing errors
        }
        throw new Error(message);
      }

      return await response.json() as BrowseSecretStoreResult;
    },
    [],
  );
  const importSecretMutation = useExecutorMutation<void, { id: string }>(async () => {
    const response = await fetch(
      `${getExecutorApiBaseUrl()}/v1/local/secret-stores/${storeId}/import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          selectionKey: selectedImportKey,
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      },
    );

    if (!response.ok) {
      let message = "Failed importing secret.";
      try {
        const payload = await response.json() as {
          message?: string;
          details?: string;
        };
        message = payload.message ?? payload.details ?? message;
      } catch {
        // ignore response parsing errors
      }
      throw new Error(message);
    }

    return await response.json() as { id: string };
  });

  useEffect(() => {
    if (storeId.length > 0) {
      return;
    }
    if (props.defaultStoreId) {
      setStoreId(props.defaultStoreId);
      return;
    }
    if (props.storeOptions.length > 0) {
      setStoreId(props.storeOptions[0]!.id);
    }
  }, [props.defaultStoreId, props.storeOptions, storeId]);

  useEffect(() => {
    setBrowserStack([]);
    setBrowserQuery("");
    setBrowserEntries([]);
    setBrowserStatus("idle");
    setBrowserError(null);
    setSelectedImportKey("");
    setSelectedImportLabel("");
    if (canImportSecrets && !canCreateSecrets) {
      setMode("import");
      return;
    }
    if (!canImportSecrets && canCreateSecrets) {
      setMode("create");
      return;
    }
    if (canImportSecrets) {
      setMode("import");
      return;
    }
    setMode("create");
  }, [canCreateSecrets, canImportSecrets, selectedStore?.id]);

  useEffect(() => {
    if (mode !== "import" || !canImportSecrets || !storeId) {
      return;
    }

    let active = true;
    setBrowserStatus("pending");
    void browseStore({
      storeId,
      parentKey: currentParentKey,
      query: browserQuery,
    })
      .then((result) => {
        if (!active) {
          return;
        }
        setBrowserEntries(result.entries);
        setBrowserError(null);
        setBrowserStatus("idle");
      })
      .catch((cause) => {
        if (!active) {
          return;
        }
        setBrowserEntries([]);
        setBrowserError(
          cause instanceof Error ? cause.message : "Failed browsing secret store.",
        );
        setBrowserStatus("idle");
      });

    return () => {
      active = false;
    };
  }, [browserQuery, browseStore, canImportSecrets, currentParentKey, mode, storeId]);

  useEffect(() => {
    if (mode !== "import" || !selectedImportLabel || name.trim().length > 0) {
      return;
    }
    setName(selectedImportLabel);
  }, [mode, name, selectedImportLabel]);

  const handleBrowserEntryClick = (entry: SecretStoreBrowserEntry) => {
    setError(null);
    if (entry.kind === "group") {
      setSelectedImportKey("");
      setSelectedImportLabel("");
      setBrowserStack((current) => [...current, {
        key: entry.key,
        label: entry.label,
      }]);
      setBrowserQuery("");
      return;
    }

    setSelectedImportKey(entry.key);
    setSelectedImportLabel(entry.label);
  };

  const handleSubmit = async () => {
    setError(null);
    const trimmedName = name.trim();

    try {
      if (mode === "import") {
        if (!selectedImportKey) {
          setError("Select a secret to import.");
          return;
        }

        await importSecretMutation.mutateAsync();
        refreshSecrets();
      } else {
        if (!trimmedName) {
          setError("Name is required.");
          return;
        }
        if (!value) {
          setError("Value is required.");
          return;
        }

        await createSecret.mutateAsync({
          name: trimmedName,
          value,
          ...(storeId ? { storeId } : {}),
        });
      }

      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed creating secret.");
    }
  };

  return (
    <FormCard
      className={props.className}
      title="New managed secret"
      onClose={props.onClose}
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldLabel label="Store">
          <select
            value={storeId}
            onChange={(event) => setStoreId(event.target.value)}
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          >
            {props.storeOptions.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </FieldLabel>
        {canImportSecrets && canCreateSecrets && (
          <FieldLabel label="Mode">
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as "create" | "import")}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            >
              <option value="import">Import from store</option>
              <option value="create">Create new secret</option>
            </select>
          </FieldLabel>
        )}
        <FieldLabel label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={mode === "import" ? "Optional override name" : "GitHub PAT"}
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
            autoFocus
          />
        </FieldLabel>
        {mode === "create" && (
          <FieldLabel label="Value">
            <input
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="ghp_..."
              className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </FieldLabel>
        )}
      </div>
      {mode === "import" && canImportSecrets && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {browserStack.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSelectedImportKey("");
                  setSelectedImportLabel("");
                  setBrowserStack((current) => current.slice(0, -1));
                }}
              >
                Back
              </Button>
            )}
            <input
              value={browserQuery}
              onChange={(event) => setBrowserQuery(event.target.value)}
              placeholder="Search this store"
              className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </div>
          {browserStack.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              {browserStack.map((crumb, index) => (
                <span key={crumb.key}>
                  {index > 0 ? " / " : ""}
                  {crumb.label}
                </span>
              ))}
            </div>
          )}
          <div className="rounded-xl border border-border bg-background/40">
            {browserStatus === "pending" ? (
              <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted-foreground">
                <IconSpinner className="size-3.5" />
                Loading store contents...
              </div>
            ) : browserEntries.length === 0 ? (
              <div className="px-4 py-3 text-[13px] text-muted-foreground">
                {browserError ?? "No importable secrets found here."}
              </div>
            ) : (
              browserEntries.map((entry, index) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => handleBrowserEntryClick(entry)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50",
                    index > 0 && "border-t border-border",
                    selectedImportKey === entry.key && "bg-accent/60",
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-foreground">
                      {entry.label}
                    </div>
                    {entry.description && (
                      <div className="truncate text-[11px] text-muted-foreground">
                        {entry.description}
                      </div>
                    )}
                  </div>
                  <Badge variant="outline">
                    {entry.kind === "group" ? "Open" : "Secret"}
                  </Badge>
                </button>
              ))
            )}
          </div>
          {browserError && browserEntries.length > 0 && (
            <div className="text-[12px] text-destructive">{browserError}</div>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={createSecret.status === "pending" || importSecretMutation.status === "pending"}
        >
          {(createSecret.status === "pending" || importSecretMutation.status === "pending")
            ? <IconSpinner className="size-3.5" />
            : <IconPlus className="size-3.5" />}
          {mode === "import" ? "Import secret" : "Store secret"}
        </Button>
      </div>
    </FormCard>
  );
}

function SecretStoreCard(props: {
  store: SecretStore;
  canManage: boolean;
}) {
  const deleteSecretStore = useDeleteSecretStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteSecretStore.mutateAsync(props.store.id);
    } catch {
      // refresh state will keep the store visible
    } finally {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card/80 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">
              {props.store.name}
            </span>
            <Badge variant="outline" className="text-[9px] uppercase">
              {props.store.kind}
            </Badge>
            <Badge variant="outline" className="text-[9px]">
              {props.store.status}
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/55">
            <span className="font-mono">{props.store.id}</span>
            <span>Created {formatDate(props.store.createdAt)}</span>
          </div>
        </div>
        {props.canManage ? (
          confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
                className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleDelete();
                }}
                disabled={isDeleting}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/8 disabled:opacity-50"
              >
                {isDeleting
                  ? <IconSpinner className="size-3" />
                  : <IconTrash className="size-3" />}
                Delete
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={isDeleting}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/8 hover:text-destructive disabled:opacity-50"
            >
              {isDeleting
                ? <IconSpinner className="size-3" />
                : <IconTrash className="size-3" />}
              Remove
            </button>
          )
        ) : (
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/45">
            Built-in
          </span>
        )}
      </div>
    </div>
  );
}

function SecretRow(props: {
  secret: SecretListItem;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
}) {
  const deleteSecret = useDeleteSecret();
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteSecret.mutateAsync(props.secret.id);
    } catch {
      // refresh state will keep the secret visible
    } finally {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">
              {props.secret.name || "Unnamed secret"}
            </span>
            <Badge variant="outline" className="text-[9px] shrink-0">
              {props.secret.purpose.replace(/_/g, " ")}
            </Badge>
            <Badge variant="outline" className="text-[9px] shrink-0">
              {props.secret.storeName}
            </Badge>
            <Badge variant="outline" className="text-[9px] shrink-0 uppercase">
              {props.secret.storeKind}
            </Badge>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/50">
            <span className="font-mono">{props.secret.id}</span>
            <span>{formatDate(props.secret.createdAt)}</span>
          </div>
          {props.secret.linkedSources.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground/50">Used by</span>
              {props.secret.linkedSources.map((linkedSource) => (
                <span
                  key={linkedSource.sourceId}
                  className="inline-flex items-center rounded-md bg-accent/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70"
                >
                  {linkedSource.sourceName}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={props.onEdit}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors",
              props.isEditing
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <IconPencil className="size-3" />
            Edit
          </button>
          {confirmDelete ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
                className="rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleDelete();
                }}
                disabled={isDeleting}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/8 disabled:opacity-50"
              >
                {isDeleting
                  ? <IconSpinner className="size-3" />
                  : <IconTrash className="size-3" />}
                Delete
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={isDeleting}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/8 hover:text-destructive disabled:opacity-50"
            >
              {isDeleting
                ? <IconSpinner className="size-3" />
                : <IconTrash className="size-3" />}
              Delete
            </button>
          )}
        </div>
      </div>

      {props.isEditing && (
        <EditSecretForm secret={props.secret} onClose={props.onCancelEdit} />
      )}
    </>
  );
}

function EditSecretForm(props: {
  secret: SecretListItem;
  onClose: () => void;
}) {
  const updateSecret = useUpdateSecret();
  const [name, setName] = useState(props.secret.name ?? "");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);

    const payload: { name?: string; value?: string } = {};
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== (props.secret.name ?? "")) {
      payload.name = trimmedName;
    }
    if (value.length > 0) {
      payload.value = value;
    }
    if (Object.keys(payload).length === 0) {
      props.onClose();
      return;
    }

    try {
      await updateSecret.mutateAsync({
        secretId: props.secret.id,
        payload,
      });
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed updating secret.");
    }
  };

  return (
    <div className="mt-3 border-t border-border/50 pt-3">
      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldLabel label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Secret name"
            className="h-8 w-full rounded-lg border border-input bg-background px-3 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
            autoFocus
          />
        </FieldLabel>
        <FieldLabel label="New value">
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Leave empty to keep existing"
            className="h-8 w-full rounded-lg border border-input bg-background px-3 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </FieldLabel>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={props.onClose}
          className="rounded-md px-3 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Cancel
        </button>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={updateSecret.status === "pending"}
        >
          {updateSecret.status === "pending" && <IconSpinner className="size-3" />}
          Save
        </Button>
      </div>
    </div>
  );
}

function FormCard(props: {
  title: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border border-primary/20 bg-card/80", props.className)}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h3 className="text-sm font-semibold text-foreground">{props.title}</h3>
        <button
          type="button"
          onClick={props.onClose}
          className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      <div className="space-y-4 p-5">{props.children}</div>
    </div>
  );
}

function ErrorBanner(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-[13px] text-destructive",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

function SectionEmptyState(props: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <p className="text-[14px] font-medium text-foreground/75">{props.title}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">{props.description}</p>
      {props.actionLabel && props.onAction && (
        <div className="mt-4 flex justify-center">
          <Button size="sm" onClick={props.onAction}>
            <IconPlus className="size-3.5" />
            {props.actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function FieldLabel(props: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

const formatDate = (value: number): string =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

import { useEffect, useState, type ReactNode } from "react";
import {
  type InstanceConfig,
  type SecretListItem,
  type Loadable,
  useSecrets,
  useCreateSecret,
  useUpdateSecret,
  useDeleteSecret,
  useInstanceConfig,
} from "@executor/react";
import { LoadableBlock } from "../components/loadable";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { IconPlus, IconPencil, IconTrash, IconSpinner } from "../components/icons";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const storableProvidersFromConfig = (config: Loadable<InstanceConfig>) =>
  config.status === "ready"
    ? config.data.secretProviders.filter((provider) => provider.canStore)
    : [];

const providerLabelForId = (config: Loadable<InstanceConfig>, providerId: string): string =>
  config.status === "ready"
    ? config.data.secretProviders.find((provider) => provider.id === providerId)?.name ?? providerId
    : providerId;

export function SecretsPage() {
  const instanceConfig = useInstanceConfig();
  const secrets = useSecrets();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const storableProviders = storableProvidersFromConfig(instanceConfig);
  const defaultProviderLabel =
    instanceConfig.status === "ready"
      ? providerLabelForId(instanceConfig, instanceConfig.data.defaultSecretStoreProvider)
      : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-10 lg:py-14">
        {/* Header */}
        <div className="flex items-end justify-between mb-8">
          <div>
            <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
              Secrets
            </h1>
            <p className="mt-1.5 text-[14px] text-muted-foreground">
              Tokens and credentials stored by executor.
              {defaultProviderLabel ? ` New secrets default to ${defaultProviderLabel}.` : ""}
            </p>
          </div>
          <Button size="sm" onClick={() => { setShowCreate(true); setEditingId(null); }}>
            <IconPlus className="size-3.5" />
            Add secret
          </Button>
        </div>

        {/* Create form */}
        {showCreate && (
          <CreateSecretForm
            onClose={() => setShowCreate(false)}
            className="mb-6"
            providerOptions={storableProviders}
            defaultProviderId={
              instanceConfig.status === "ready"
                ? instanceConfig.data.defaultSecretStoreProvider
                : null
            }
          />
        )}

        {/* Secrets table */}
        <LoadableBlock loadable={secrets} loading="Loading secrets...">
          {(items) =>
            items.length === 0 && !showCreate ? (
              <EmptyState onAdd={() => setShowCreate(true)} />
            ) : (
              <div className="rounded-xl border border-border bg-card/80 divide-y divide-border overflow-hidden">
                {items.map((secret) => (
                  <SecretRow
                    key={secret.id}
                    secret={secret}
                    providerLabel={providerLabelForId(instanceConfig, secret.providerId)}
                    isEditing={editingId === secret.id}
                    onEdit={() => setEditingId(editingId === secret.id ? null : secret.id)}
                    onCancelEdit={() => setEditingId(null)}
                  />
                ))}
                {items.length === 0 && (
                  <div className="px-5 py-8 text-center text-[13px] text-muted-foreground/60">
                    No secrets yet. Add one above.
                  </div>
                )}
              </div>
            )
          }
        </LoadableBlock>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState(props: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-4">
        <KeyIcon className="size-5" />
      </div>
      <p className="text-[14px] font-medium text-foreground/70 mb-1">
        No secrets stored
      </p>
      <p className="text-[13px] text-muted-foreground/60 mb-5">
        Secrets let you securely provide tokens for source authentication without putting them in workspace config.
      </p>
      <Button size="sm" onClick={props.onAdd}>
        <IconPlus className="size-3.5" />
        Add secret
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

function CreateSecretForm(props: {
  onClose: () => void;
  className?: string;
  providerOptions: ReadonlyArray<{ id: string; name: string }>;
  defaultProviderId: string | null;
}) {
  const createSecret = useCreateSecret();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [providerId, setProviderId] = useState(props.defaultProviderId ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (providerId.length > 0) {
      return;
    }
    if (props.defaultProviderId) {
      setProviderId(props.defaultProviderId);
    }
  }, [props.defaultProviderId, providerId]);

  const handleSubmit = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (!value) {
      setError("Value is required.");
      return;
    }

    try {
      await createSecret.mutateAsync({
        name: trimmedName,
        value,
        ...(providerId ? { providerId } : {}),
      });
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed creating secret.");
    }
  };

  return (
    <div className={cn("rounded-xl border border-primary/20 bg-card/80", props.className)}>
      <div className="border-b border-border px-5 py-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">New secret</h2>
        <button
          type="button"
          onClick={props.onClose}
          className="text-[12px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
      <div className="p-5 space-y-4">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-[13px] text-destructive">
            {error}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldLabel label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="GitHub PAT"
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
              autoFocus
            />
          </FieldLabel>
          <FieldLabel label="Value">
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="ghp_..."
              className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </FieldLabel>
          <FieldLabel label="Store in">
            <select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            >
              {props.providerOptions.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </FieldLabel>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={createSecret.status === "pending"}
          >
            {createSecret.status === "pending" ? <IconSpinner className="size-3.5" /> : <IconPlus className="size-3.5" />}
            Store secret
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secret row
// ---------------------------------------------------------------------------

function SecretRow(props: {
  secret: SecretListItem;
  providerLabel: string;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
}) {
  const { secret, providerLabel, isEditing } = props;
  const deleteSecret = useDeleteSecret();
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteSecret.mutateAsync(secret.id);
    } catch {
      // refresh will show the secret still there
    } finally {
      setConfirmDelete(false);
      setIsDeleting(false);
    }
  };

  const createdDate = new Date(secret.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="px-5 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
            <KeyIcon className="size-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-foreground truncate">
                {secret.name || "Unnamed secret"}
              </span>
              <Badge variant="outline" className="text-[9px] shrink-0">
                {secret.purpose.replace(/_/g, " ")}
              </Badge>
              <Badge variant="outline" className="text-[9px] shrink-0">
                {providerLabel}
              </Badge>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] font-mono text-muted-foreground/50 truncate">
                {secret.id}
              </span>
              <span className="text-[11px] text-muted-foreground/40">
                {createdDate}
              </span>
            </div>
            {secret.linkedSources.length > 0 && (
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span className="text-[10px] text-muted-foreground/50">Used by</span>
                {secret.linkedSources.map((ls) => (
                  <span
                    key={ls.sourceId}
                    className="inline-flex items-center gap-1 rounded-md bg-accent/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70"
                  >
                    {ls.sourceName}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={props.onEdit}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors",
              isEditing
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
            )}
          >
            <IconPencil className="size-3" />
            Edit
          </button>
          {confirmDelete ? (
            <>
              <span className="text-[10px] font-medium text-destructive">
                Confirm delete?
              </span>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
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
                {isDeleting ? <IconSpinner className="size-3" /> : <IconTrash className="size-3" />}
                {isDeleting ? "Deleting..." : "Delete"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={isDeleting}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-destructive hover:bg-destructive/8 disabled:opacity-50"
            >
              {isDeleting ? <IconSpinner className="size-3" /> : <IconTrash className="size-3" />}
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Inline edit */}
      {isEditing && (
        <EditSecretForm
          secret={secret}
          onClose={props.onCancelEdit}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit form (inline)
// ---------------------------------------------------------------------------

function EditSecretForm(props: { secret: SecretListItem; onClose: () => void }) {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed updating secret.");
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-[13px] text-destructive mb-3">
          {error}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldLabel label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Secret name"
            className="h-8 w-full rounded-lg border border-input bg-background px-3 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
            autoFocus
          />
        </FieldLabel>
        <FieldLabel label="New value (leave empty to keep current)">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Leave empty to keep existing"
            className="h-8 w-full rounded-lg border border-input bg-background px-3 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-ring focus:ring-1 focus:ring-ring/25"
          />
        </FieldLabel>
      </div>
      <div className="flex items-center justify-end gap-2 mt-3">
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

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function FieldLabel(props: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

function KeyIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-4", props.className)}>
      <path
        d="M10 6a4 4 0 10-4.9 3.9L2 13v1.5h2V13h1.5v-1.5H7l.6-.6A4 4 0 0010 6z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="10.5" cy="5.5" r="1" fill="currentColor" />
    </svg>
  );
}

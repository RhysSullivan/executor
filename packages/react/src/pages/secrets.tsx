import { useState, Suspense } from "react";
import { useAtomValue, useAtomSet, Result } from "@effect-atom/atom-react";
import { secretsAtom, setSecret, removeSecret } from "../api/atoms";
import { secretWriteKeys } from "../api/reactivity-keys";
import type { SecretProviderPlugin } from "../plugins/secret-provider-plugin";
import { SecretId } from "@executor/sdk";
import { useScope } from "../hooks/use-scope";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "../components/dialog";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { Label } from "../components/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
} from "../components/card-stack";
import { Badge } from "../components/badge";

type SecretStorageOption = {
  readonly label: string;
  readonly value: string;
};

const defaultStorageOptions: readonly SecretStorageOption[] = [
  { value: "auto", label: "Auto" },
  { value: "keychain", label: "Keychain" },
  { value: "file", label: "File" },
];

// ---------------------------------------------------------------------------
// Add secret dialog
// ---------------------------------------------------------------------------

function AddSecretDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  description: string;
  storageOptions: readonly SecretStorageOption[];
}) {
  const initialProvider = props.storageOptions[0]?.value ?? "auto";
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [provider, setProvider] = useState(initialProvider);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeId = useScope();
  const doSet = useAtomSet(setSecret, { mode: "promise" });

  const reset = () => {
    setId("");
    setName("");
    setValue("");
    setProvider(initialProvider);
    setError(null);
    setSaving(false);
  };

  const handleSave = async () => {
    if (!id.trim() || !name.trim() || !value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await doSet({
        path: { scopeId },
        payload: {
          id: SecretId.make(id.trim()),
          name: name.trim(),
          value: value.trim(),
          provider: provider === "auto" ? undefined : provider,
        },
        reactivityKeys: secretWriteKeys,
      });
      reset();
      props.onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save secret");
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(v) => {
        if (!v) reset();
        props.onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">New secret</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {props.description}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label
                htmlFor="secret-id"
                className="text-sm font-medium uppercase tracking-wider text-muted-foreground"
              >
                ID
              </Label>
              <Input
                id="secret-id"
                placeholder="github-token"
                value={id}
                onChange={(e) => setId((e.target as HTMLInputElement).value)}
                className="font-mono text-xs h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label
                htmlFor="secret-name"
                className="text-sm font-medium uppercase tracking-wider text-muted-foreground"
              >
                Name
              </Label>
              <Input
                id="secret-name"
                placeholder="GitHub PAT"
                value={name}
                onChange={(e) => setName((e.target as HTMLInputElement).value)}
                className="text-sm h-9"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label
              htmlFor="secret-value"
              className="text-sm font-medium uppercase tracking-wider text-muted-foreground"
            >
              Value
            </Label>
            <Input
              id="secret-value"
              type="password"
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              value={value}
              onChange={(e) => setValue((e.target as HTMLInputElement).value)}
              className="font-mono text-xs h-9"
            />
          </div>

          <div className="grid gap-3">
            {props.storageOptions.length > 1 && (
              <div className="grid gap-1.5">
                <Label
                  htmlFor="secret-provider"
                  className="text-sm font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Storage
                </Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger id="secret-provider" className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {props.storageOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!id.trim() || !name.trim() || !value.trim() || saving}
          >
            {saving ? "Saving…" : "Save secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Secret row
// ---------------------------------------------------------------------------

function SecretRow(props: {
  showProvider: boolean;
  secret: { id: string; name: string; provider?: string };
  onRemove: () => void;
}) {
  const { secret, showProvider } = props;

  return (
    <CardStackEntry>
      <CardStackEntryContent>
        <CardStackEntryTitle className="flex items-center gap-2">
          <span className="truncate">{secret.name}</span>
        </CardStackEntryTitle>
      </CardStackEntryContent>
      <CardStackEntryActions>
        {showProvider && secret.provider && <Badge variant="outline">{secret.provider}</Badge>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-0 transition-opacity group-hover/card-stack-entry:opacity-100 group-focus-within/card-stack-entry:opacity-100 data-[state=open]:opacity-100"
            >
              <svg viewBox="0 0 16 16" className="size-3">
                <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                <circle cx="8" cy="13" r="1.2" fill="currentColor" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              className="text-destructive focus:text-destructive text-sm"
              onClick={props.onRemove}
            >
              Remove secret
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardStackEntryActions>
    </CardStackEntry>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SecretsPage(props: {
  addSecretDescription?: string;
  showProviderInfo?: boolean;
  secretProviderPlugins: readonly SecretProviderPlugin[];
  storageOptions?: readonly SecretStorageOption[];
}) {
  const storageOptions = props.storageOptions ?? defaultStorageOptions;
  const showProviderInfo = props.showProviderInfo ?? true;
  const addSecretDescription =
    props.addSecretDescription ??
    "Store a credential or API key. Values are kept in your system keychain when available, with a local encrypted file fallback.";
  const { secretProviderPlugins } = props;
  const [addOpen, setAddOpen] = useState(false);
  const scopeId = useScope();
  const secrets = useAtomValue(secretsAtom(scopeId));
  const doRemove = useAtomSet(removeSecret, { mode: "promise" });

  const handleRemove = async (secretId: string) => {
    try {
      await doRemove({
        path: {
          scopeId,
          secretId: SecretId.make(secretId),
        },
        reactivityKeys: secretWriteKeys,
      });
    } catch {
      // TODO: toast
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        {/* Header */}
        <div className="flex items-end justify-between mb-10">
          <div>
            <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none">
              Secrets
            </h1>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              Credentials and API keys used by your connected sources.
            </p>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            Add secret
          </Button>
        </div>

        {/* Provider plugins */}
        {showProviderInfo && secretProviderPlugins.length > 0 && (
          <div className="mb-10">
            <CardStack>
              <CardStackHeader>Providers</CardStackHeader>
              <CardStackContent>
                {secretProviderPlugins.map((plugin) => (
                  <Suspense
                    key={plugin.key}
                    fallback={
                      <div className="px-4 py-3 animate-pulse">
                        <div className="h-4 w-24 rounded bg-muted" />
                      </div>
                    }
                  >
                    <plugin.settings />
                  </Suspense>
                ))}
              </CardStackContent>
            </CardStack>
          </div>
        )}

        {/* Secrets list */}
        {Result.match(secrets, {
          onInitial: () => (
            <div className="flex items-center gap-2 py-8">
              <div className="size-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
              <p className="text-sm text-muted-foreground">Loading secrets…</p>
            </div>
          ),
          onFailure: () => (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">Failed to load secrets</p>
            </div>
          ),
          onSuccess: ({ value }) => (
            <CardStack>
              <CardStackHeader>Secrets</CardStackHeader>
              <CardStackContent>
                {value.length === 0 ? (
                  <CardStackEntry>
                    <CardStackEntryContent>
                      <CardStackEntryDescription>
                        Add API keys and credentials to authenticate your sources.
                      </CardStackEntryDescription>
                    </CardStackEntryContent>
                    <CardStackEntryActions>
                      <Button
                        variant="link"
                        size="sm"
                        className="h-7 px-0 text-xs"
                        onClick={() => setAddOpen(true)}
                      >
                        Add your first secret
                      </Button>
                    </CardStackEntryActions>
                  </CardStackEntry>
                ) : (
                  value.map((s) => (
                    <SecretRow
                      key={s.id}
                      showProvider={showProviderInfo}
                      secret={{
                        id: s.id,
                        name: s.name,
                        provider: s.provider ? String(s.provider) : undefined,
                      }}
                      onRemove={() => handleRemove(s.id)}
                    />
                  ))
                )}
              </CardStackContent>
            </CardStack>
          ),
        })}

        <AddSecretDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          description={addSecretDescription}
          storageOptions={storageOptions}
        />
      </div>
    </div>
  );
}

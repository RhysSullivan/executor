import { useState, Suspense } from "react";
import {
  useAtomValue,
  useAtomSet,
  useAtomRefresh,
  Result,
  secretsAtom,
  setSecret,
  removeSecret,
} from "@executor/react";
import type { SecretProviderPlugin } from "@executor/react";
import { SecretId } from "@executor/sdk";
import { useScope } from "../lib/use-scope";
import { onePasswordSecretProviderPlugin } from "@executor/plugin-onepassword/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@executor/ui/components/dialog";
import { Button } from "@executor/ui/components/button";
import { Input } from "@executor/ui/components/input";
import { Label } from "@executor/ui/components/label";
import { Badge } from "@executor/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@executor/ui/components/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor/ui/components/select";

// ---------------------------------------------------------------------------
// Add secret dialog
// ---------------------------------------------------------------------------

function AddSecretDialog(props: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [purpose, setPurpose] = useState("");
  const [provider, setProvider] = useState("auto");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeId = useScope();
  const doSet = useAtomSet(setSecret, { mode: "promise" });
  const refresh = useAtomRefresh(secretsAtom(scopeId));

  const reset = () => {
    setId("");
    setName("");
    setValue("");
    setPurpose("");
    setProvider("auto");
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
          purpose: purpose.trim() || undefined,
          provider: provider === "auto" ? undefined : provider,
        },
      });
      reset();
      props.onOpenChange(false);
      refresh();
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
          <DialogDescription className="text-[13px] leading-relaxed">
            Store a credential or API key. Values are kept in your system
            keychain when available, with a local encrypted file fallback.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="secret-id" className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                ID
              </Label>
              <Input
                id="secret-id"
                placeholder="github-token"
                value={id}
                onChange={(e) => setId((e.target as HTMLInputElement).value)}
                className="font-mono text-[13px] h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="secret-name" className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Name
              </Label>
              <Input
                id="secret-name"
                placeholder="GitHub PAT"
                value={name}
                onChange={(e) => setName((e.target as HTMLInputElement).value)}
                className="text-[13px] h-9"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="secret-value" className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Value
            </Label>
            <Input
              id="secret-value"
              type="password"
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              value={value}
              onChange={(e) => setValue((e.target as HTMLInputElement).value)}
              className="font-mono text-[13px] h-9"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="secret-purpose" className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Purpose <span className="normal-case tracking-normal font-normal text-muted-foreground/60">(opt.)</span>
              </Label>
              <Input
                id="secret-purpose"
                placeholder="GitHub API auth"
                value={purpose}
                onChange={(e) => setPurpose((e.target as HTMLInputElement).value)}
                className="text-[13px] h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="secret-provider" className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Storage
              </Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger id="secret-provider" className="h-9 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="keychain">Keychain</SelectItem>
                  <SelectItem value="file">File</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">Cancel</Button>
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
  secret: { id: string; name: string; purpose?: string; provider?: string };
  onRemove: () => void;
}) {
  const { secret } = props;

  return (
    <div className="group relative flex items-center gap-4 rounded-lg border border-border/60 bg-card px-4 py-3 transition-all hover:border-border hover:shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-medium text-foreground leading-none">{secret.name}</p>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
            {secret.id}
          </span>
        </div>
        {secret.purpose && (
          <p className="mt-1 text-[12px] text-muted-foreground/70 leading-none">{secret.purpose}</p>
        )}
      </div>

      {/* Provider + actions */}
      <div className="flex items-center gap-1.5">
        {secret.provider && (
          <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground leading-none">
            {secret.provider}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-0 group-hover:opacity-100 transition-opacity"
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
              className="text-destructive focus:text-destructive text-[12px]"
              onClick={props.onRemove}
            >
              Remove secret
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secret provider plugins
// ---------------------------------------------------------------------------

const secretProviderPlugins: SecretProviderPlugin[] = [
  onePasswordSecretProviderPlugin,
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SecretsPage() {
  const [addOpen, setAddOpen] = useState(false);
  const scopeId = useScope();
  const secrets = useAtomValue(secretsAtom(scopeId));
  const doRemove = useAtomSet(removeSecret, { mode: "promise" });
  const refresh = useAtomRefresh(secretsAtom(scopeId));

  const handleRemove = async (secretId: string) => {
    try {
      await doRemove({
        path: {
          scopeId,
          secretId: SecretId.make(secretId),
        },
      });
      refresh();
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
            <p className="mt-2 text-[13px] text-muted-foreground leading-relaxed">
              Credentials and API keys used by your connected sources.
            </p>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            Add secret
          </Button>
        </div>

        {/* Provider plugins */}
        {secretProviderPlugins.length > 0 && (
          <div className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
                Providers
              </h2>
              <div className="flex-1 h-px bg-border/50" />
            </div>
            <div className="grid gap-3">
              {secretProviderPlugins.map((plugin) => (
                <Suspense
                  key={plugin.key}
                  fallback={
                    <div className="rounded-xl border border-border/60 bg-card p-5 animate-pulse">
                      <div className="h-4 w-24 rounded bg-muted" />
                    </div>
                  }
                >
                  <plugin.settings />
                </Suspense>
              ))}
            </div>
          </div>
        )}

        {/* Secrets list */}
        {Result.match(secrets, {
          onInitial: () => (
            <div className="flex items-center gap-2 py-8">
              <div className="size-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
              <p className="text-[13px] text-muted-foreground/60">Loading secrets…</p>
            </div>
          ),
          onFailure: () => (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-[13px] text-destructive">Failed to load secrets</p>
            </div>
          ),
          onSuccess: ({ value }) =>
            value.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 py-16">
                  <p className="text-[13px] font-medium text-foreground/60 mb-1">
                  No secrets yet
                </p>
                <p className="text-[12px] text-muted-foreground/50 mb-5 max-w-[240px] text-center leading-relaxed">
                  Add API keys and credentials to authenticate your sources.
                </p>
                <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                  Add your first secret
                </Button>
              </div>
            ) : (
              <div className="grid gap-1.5">
                {value.map((s) => (
                  <SecretRow
                    key={s.id}
                    secret={{
                      id: s.id,
                      name: s.name,
                      purpose: s.purpose,
                      provider: s.provider ? String(s.provider) : undefined,
                    }}
                    onRemove={() => handleRemove(s.id)}
                  />
                ))}
              </div>
            ),
        })}

        <AddSecretDialog open={addOpen} onOpenChange={setAddOpen} />
      </div>
    </div>
  );
}

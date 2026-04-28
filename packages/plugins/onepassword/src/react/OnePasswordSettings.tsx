import { useState } from "react";
import { useAtomSet, useAtomValue } from "@effect-atom/atom-react";
import { Result } from "@effect-atom/atom-react";
import { ReactivityKey } from "@executor/react/api/reactivity-keys";
import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor/react/components/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@executor/react/components/dialog";
import {
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
} from "@executor/react/components/card-stack";

import {
  onepasswordConfigAtom,
  onepasswordVaultsAtom,
  configureOnePassword,
  removeOnePasswordConfig,
} from "./atoms";
import type { OnePasswordConfig } from "../sdk/types";

// ---------------------------------------------------------------------------
// Vault picker
// ---------------------------------------------------------------------------

function VaultPicker(props: {
  authKind: "desktop-app" | "service-account";
  accountName: string;
  vaultId: string;
  onVaultSelect: (id: string, name: string) => void;
}) {
  const account = props.accountName.trim();
  const scopeId = useScope();
  const vaultsResult = useAtomValue(onepasswordVaultsAtom(props.authKind, account, scopeId));

  const { vaults, isLoading, error } = Result.matchWithError(
    vaultsResult as Result.Result<{ vaults: ReadonlyArray<{ id: string; name: string }> }, Error>,
    {
      onInitial: () => ({
        vaults: [] as { id: string; name: string }[],
        isLoading: true,
        error: null,
      }),
      onError: (error) => ({
        vaults: [] as { id: string; name: string }[],
        isLoading: false,
        error: error.message,
      }),
      onDefect: (defect) => ({
        vaults: [] as { id: string; name: string }[],
        isLoading: false,
        error: defect instanceof Error ? defect.message : "Failed to list vaults",
      }),
      onSuccess: ({ value }) => {
        const v = value.vaults;
        if (v.length > 0 && !props.vaultId) {
          queueMicrotask(() => props.onVaultSelect(v[0].id, v[0].name));
        }
        return { vaults: [...v], isLoading: false, error: null };
      },
    },
  );

  if (!account) {
    return (
      <p className="text-[11px] text-muted-foreground/50 py-1">
        Enter account details to load vaults.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      <Select
        disabled={isLoading || vaults.length === 0}
        value={props.vaultId}
        onValueChange={(id) => {
          const v = vaults.find((vault) => vault.id === id);
          if (v) props.onVaultSelect(v.id, v.name);
        }}
      >
        <SelectTrigger className="h-9 text-[13px]">
          <SelectValue placeholder={isLoading ? "Loading…" : "Select a vault"} />
        </SelectTrigger>
        <SelectContent>
          {vaults.map((v) => (
            <SelectItem key={v.id} value={v.id}>
              {v.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-1.5">
          <p className="text-[11px] text-destructive leading-relaxed whitespace-pre-line">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config dialog
// ---------------------------------------------------------------------------

function ConfigDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial?: { authKind: string; accountName: string; vaultId: string; name: string };
}) {
  const isEdit = !!props.initial;
  const [authKind, setAuthKind] = useState<"desktop-app" | "service-account">(
    (props.initial?.authKind as "desktop-app" | "service-account") ?? "desktop-app",
  );
  const [accountName, setAccountName] = useState(props.initial?.accountName ?? "my.1password.com");
  const [vaultId, setVaultId] = useState(props.initial?.vaultId ?? "");
  const [vaultName, setVaultName] = useState(props.initial?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeId = useScope();
  const doConfigure = useAtomSet(configureOnePassword, { mode: "promise" });

  const reset = () => {
    if (!isEdit) {
      setAuthKind("desktop-app");
      setAccountName("my.1password.com");
      setVaultId("");
      setVaultName("");
    }
    setError(null);
    setSaving(false);
  };

  const handleSave = async () => {
    if (!accountName.trim() || !vaultId.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const auth =
        authKind === "desktop-app"
          ? { kind: "desktop-app" as const, accountName: accountName.trim() }
          : { kind: "service-account" as const, tokenSecretId: accountName.trim() };

      await doConfigure({
        path: { scopeId },
        payload: { auth, vaultId: vaultId.trim(), name: vaultName.trim() || "1Password" },
        reactivityKeys: [ReactivityKey.secrets],
      });
      props.onOpenChange(false);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save configuration");
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
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">
            {isEdit ? "Edit 1Password" : "Connect 1Password"}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            Link a vault to resolve secrets via the 1Password desktop app or a service account.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-3">
          {/* Auth method */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Auth method
            </Label>
            <Select
              value={authKind}
              onValueChange={(v) => setAuthKind(v as "desktop-app" | "service-account")}
            >
              <SelectTrigger className="h-9 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desktop-app">Desktop App (biometric)</SelectItem>
                <SelectItem value="service-account">Service Account</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Account / token */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {authKind === "desktop-app" ? "Account domain" : "Token secret ID"}
            </Label>
            <Input
              placeholder={authKind === "desktop-app" ? "my.1password.com" : "op-service-token"}
              value={accountName}
              onChange={(e) => setAccountName((e.target as HTMLInputElement).value)}
              className="font-mono text-[13px] h-9"
            />
            <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
              {authKind === "desktop-app"
                ? "Requires the 1Password desktop app with biometric unlock."
                : "Reference an executor secret that holds the service account token."}
            </p>
          </div>

          {/* Vault */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Vault
            </Label>
            <VaultPicker
              authKind={authKind}
              accountName={accountName}
              vaultId={vaultId}
              onVaultSelect={(id, name) => {
                setVaultId(id);
                setVaultName(name);
              }}
            />
            {vaultId && <p className="font-mono text-[10px] text-muted-foreground/50">{vaultId}</p>}
          </div>

          {/* Display name */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Display name
            </Label>
            <Input
              placeholder="1Password"
              value={vaultName}
              onChange={(e) => setVaultName((e.target as HTMLInputElement).value)}
              className="text-[13px] h-9"
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive whitespace-pre-line">{error}</p>
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
            disabled={!accountName.trim() || !vaultId.trim() || saving}
          >
            {saving ? "Saving…" : isEdit ? "Update" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Settings card
// ---------------------------------------------------------------------------

export default function OnePasswordSettings() {
  const [configOpen, setConfigOpen] = useState(false);
  const scopeId = useScope();
  const configResult = useAtomValue(onepasswordConfigAtom(scopeId));
  const doRemove = useAtomSet(removeOnePasswordConfig, { mode: "promise" });

  const handleRemove = async () => {
    try {
      await doRemove({ path: { scopeId }, reactivityKeys: [ReactivityKey.secrets] });
    } catch {
      /* TODO: toast */
    }
  };

  const config: OnePasswordConfig | null = Result.match(
    configResult as Result.Result<OnePasswordConfig | null, unknown>,
    { onInitial: () => null, onFailure: () => null, onSuccess: ({ value }) => value },
  );
  const isLoading = Result.match(configResult as Result.Result<OnePasswordConfig | null, unknown>, {
    onInitial: () => true,
    onFailure: () => false,
    onSuccess: () => false,
  });
  const isError = Result.match(configResult as Result.Result<OnePasswordConfig | null, unknown>, {
    onInitial: () => false,
    onFailure: () => true,
    onSuccess: () => false,
  });

  return (
    <>
      <CardStackEntry>
        <CardStackEntryContent>
          {isLoading ? (
            <CardStackEntryDescription>Loading…</CardStackEntryDescription>
          ) : isError ? (
            <CardStackEntryDescription className="text-destructive">
              Failed to load configuration
            </CardStackEntryDescription>
          ) : config ? (
            <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[12px]">
              <span className="text-muted-foreground/60">Auth</span>
              <span className="font-mono text-foreground/80 truncate">
                {config.auth.kind === "desktop-app" ? config.auth.accountName : "service-account"}
              </span>
              <span className="text-muted-foreground/60">Vault</span>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-foreground/80 truncate">{config.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground/40 truncate">
                  {config.vaultId}
                </span>
              </div>
            </div>
          ) : (
            <CardStackEntryDescription>
              Resolve secrets from your 1Password vault.
            </CardStackEntryDescription>
          )}
        </CardStackEntryContent>
        <CardStackEntryActions>
          {config ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-[12px]"
                onClick={() => setConfigOpen(true)}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-[12px] text-destructive/70 hover:text-destructive"
                onClick={handleRemove}
              >
                Disconnect
              </Button>
            </>
          ) : (
            !isLoading &&
            !isError && (
              <Button
                variant="link"
                size="sm"
                className="h-7 px-0 text-[12px] shrink-0"
                onClick={() => setConfigOpen(true)}
              >
                Add 1Password
              </Button>
            )
          )}
        </CardStackEntryActions>
      </CardStackEntry>

      {configOpen && (
        <ConfigDialog
          open={configOpen}
          onOpenChange={setConfigOpen}
          initial={
            config
              ? {
                  authKind: config.auth.kind,
                  accountName:
                    config.auth.kind === "desktop-app"
                      ? config.auth.accountName
                      : config.auth.tokenSecretId,
                  vaultId: config.vaultId,
                  name: config.name,
                }
              : undefined
          }
        />
      )}
    </>
  );
}

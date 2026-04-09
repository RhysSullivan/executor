import { useState } from "react";
import { useAtomRefresh, useAtomSet } from "@effect-atom/atom-react";

import { secretsAtom, setSecret, resolveSecret } from "../api/atoms";
import { useScope } from "../api/scope-context";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { Spinner } from "../components/spinner";
import { SecretPicker, type SecretPickerSecret } from "./secret-picker";
import { SecretId } from "@executor/sdk";

export interface HeaderAuthPreset {
  readonly key: string;
  readonly label: string;
  readonly name: string;
  readonly prefix?: string;
}

export const defaultHeaderAuthPresets: readonly HeaderAuthPreset[] = [
  { key: "bearer", label: "Bearer Token", name: "Authorization", prefix: "Bearer " },
  { key: "basic", label: "Basic Auth", name: "Authorization", prefix: "Basic " },
  { key: "api-key", label: "API Key", name: "X-API-Key" },
  { key: "auth-token", label: "Auth Token", name: "X-Auth-Token" },
  { key: "access-token", label: "Access Token", name: "X-Access-Token" },
  { key: "cookie", label: "Cookie", name: "Cookie" },
  { key: "custom", label: "Custom", name: "" },
];

function SecretVisibilityIcon(props: { revealed: boolean }) {
  return props.revealed ? (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 2l12 12" />
      <path d="M6.5 6.5a2 2 0 0 0 3 3" />
      <path d="M3.5 5.5C2.3 6.7 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1 0 1.9-.3 2.7-.7" />
      <path d="M10.7 10.7c2-1.4 3.3-3.2 3.8-3.7 0 0-2.5-5-6.5-5-.7 0-1.4.1-2 .4" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function InlineCreateSecret(props: {
  headerName: string;
  suggestedId: string;
  onCreated: (secretId: string) => void;
  onCancel: () => void;
}) {
  const [secretId, setSecretId] = useState(props.suggestedId);
  const [secretName, setSecretName] = useState(props.headerName);
  const [secretValue, setSecretValue] = useState("");
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeId = useScope();
  const doSet = useAtomSet(setSecret, { mode: "promise" });
  const refreshSecrets = useAtomRefresh(secretsAtom(scopeId));

  const handleSave = async () => {
    if (!secretId.trim() || !secretValue.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await doSet({
        path: { scopeId },
        payload: {
          id: SecretId.make(secretId.trim()),
          name: secretName.trim() || secretId.trim(),
          value: secretValue.trim(),
          purpose: `Auth header: ${props.headerName}`,
        },
      });
      refreshSecrets();
      props.onCreated(secretId.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save secret");
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.02] p-3 space-y-2.5">
      <p className="text-[11px] font-semibold text-primary tracking-wide uppercase">New secret</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">ID</Label>
          <Input
            value={secretId}
            onChange={(e) => setSecretId((e.target as HTMLInputElement).value)}
            placeholder="my-api-token"
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Label</Label>
          <Input
            value={secretName}
            onChange={(e) => setSecretName((e.target as HTMLInputElement).value)}
            placeholder="API Token"
            className="h-8 text-xs"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Value</Label>
        <div className="relative">
          <Input
            type={secretRevealed ? "text" : "password"}
            value={secretValue}
            onChange={(e) => setSecretValue((e.target as HTMLInputElement).value)}
            placeholder="paste your token or key…"
            className="h-8 pr-8 text-xs font-mono"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => setSecretRevealed((revealed) => !revealed)}
            aria-label={secretRevealed ? "Hide secret value" : "Reveal secret value"}
          >
            <SecretVisibilityIcon revealed={secretRevealed} />
          </Button>
        </div>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex gap-1.5 pt-0.5">
        <Button variant="outline" size="xs" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={handleSave}
          disabled={!secretId.trim() || !secretValue.trim() || saving}
        >
          {saving ? "Saving…" : "Create & use"}
        </Button>
      </div>
    </div>
  );
}

type ResolveState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "revealed"; value: string }
  | { status: "error" };

function HeaderValuePreview(props: {
  headerName: string;
  secretId: string;
  prefix?: string;
}) {
  const { headerName, secretId, prefix } = props;
  const scopeId = useScope();
  const [state, setState] = useState<ResolveState>({ status: "hidden" });
  const doResolve = useAtomSet(resolveSecret, { mode: "promise" });

  const handleToggle = async () => {
    if (state.status === "revealed") {
      setState({ status: "hidden" });
      return;
    }
    setState({ status: "loading" });
    try {
      const result = await doResolve({
        path: {
          scopeId,
          secretId: SecretId.make(secretId),
        },
      });
      setState({ status: "revealed", value: result.value });
    } catch {
      setState({ status: "error" });
    }
  };

  const displayValue =
    state.status === "revealed" ? state.value
    : state.status === "error" ? "failed to resolve"
    : "•".repeat(12);
  const isLoading = state.status === "loading";
  const isRevealed = state.status === "revealed";

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-xs">
      <span className="text-muted-foreground shrink-0">{headerName}:</span>
      <span className="text-foreground truncate">
        {prefix && <span className="text-muted-foreground">{prefix}</span>}
        {displayValue}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="ml-auto shrink-0"
        onClick={handleToggle}
        disabled={isLoading}
      >
        {isLoading ? (
          <Spinner className="size-3" />
        ) : (
          <SecretVisibilityIcon revealed={isRevealed} />
        )}
      </Button>
    </div>
  );
}

export function SecretHeaderAuthRow(props: {
  name: string;
  prefix?: string;
  presetKey?: string;
  secretId: string | null;
  onChange: (update: { name: string; prefix?: string; presetKey?: string }) => void;
  onSelectSecret: (secretId: string) => void;
  existingSecrets: readonly SecretPickerSecret[];
  presets?: readonly HeaderAuthPreset[];
  onRemove?: () => void;
  removeLabel?: string;
  label?: string;
}) {
  const [creating, setCreating] = useState(false);
  const {
    name,
    prefix,
    presetKey,
    secretId,
    onChange,
    onSelectSecret,
    existingSecrets,
    presets = defaultHeaderAuthPresets,
    onRemove,
    removeLabel = "Remove",
    label = "Header",
  } = props;

  const isCustom = presetKey === "custom";
  const suggestedId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "custom-header";

  if (creating) {
    return (
      <InlineCreateSecret
        headerName={name || "Custom Header"}
        suggestedId={suggestedId}
        onCreated={(id) => {
          onSelectSecret(id);
          setCreating(false);
        }}
        onCancel={() => setCreating(false)}
      />
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</Label>
        {onRemove && (
          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={onRemove}>
            {removeLabel}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        {presets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            onClick={() =>
              onChange({
                name: preset.name,
                prefix: preset.prefix,
                presetKey: preset.key,
              })
            }
            className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
              presetKey === preset.key
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:text-foreground hover:bg-accent/50"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {presetKey !== undefined && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Name</Label>
            <Input
              value={name}
              onChange={(e) =>
                onChange({
                  name: (e.target as HTMLInputElement).value,
                  prefix,
                  presetKey: isCustom ? "custom" : presetKey,
                })
              }
              placeholder="Authorization"
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Prefix <span className="normal-case tracking-normal font-normal text-muted-foreground/60">(opt.)</span></Label>
            <Input
              value={prefix ?? ""}
              onChange={(e) =>
                onChange({
                  name,
                  prefix: (e.target as HTMLInputElement).value || undefined,
                  presetKey: isCustom ? "custom" : presetKey,
                })
              }
              placeholder="Bearer "
              className="h-8 text-xs font-mono"
            />
          </div>
        </div>
      )}

      {presetKey !== undefined && name.trim() && (
        <div className="flex items-center gap-1.5">
          <div className="flex-1 min-w-0">
            <SecretPicker
              value={secretId}
              onSelect={onSelectSecret}
              secrets={existingSecrets}
            />
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setCreating(true)}>
            + New
          </Button>
        </div>
      )}

      {secretId && name.trim() && (
        <HeaderValuePreview
          headerName={name.trim()}
          secretId={secretId}
          prefix={prefix}
        />
      )}
    </div>
  );
}

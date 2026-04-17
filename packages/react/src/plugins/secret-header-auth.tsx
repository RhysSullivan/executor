import { useId, useState, type CSSProperties } from "react";
import { useAtomSet } from "@effect-atom/atom-react";

import { setSecret, resolveSecret } from "../api/atoms";
import { secretWriteKeys } from "../api/reactivity-keys";
import { useScope } from "../api/scope-context";
import { Button } from "../components/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "../components/field";
import { Input } from "../components/input";
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
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 2l12 12" />
      <path d="M6.5 6.5a2 2 0 0 0 3 3" />
      <path d="M3.5 5.5C2.3 6.7 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1 0 1.9-.3 2.7-.7" />
      <path d="M10.7 10.7c2-1.4 3.3-3.2 3.8-3.7 0 0-2.5-5-6.5-5-.7 0-1.4.1-2 .4" />
    </svg>
  ) : (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function slugifyForSecretId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function InlineCreateSecret(props: {
  suggestedId: string;
  suggestedName: string;
  onCreated: (secretId: string) => void;
  onCancel: () => void;
}) {
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [idOverride, setIdOverride] = useState<string | null>(null);
  const [secretValue, setSecretValue] = useState("");
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeId = useScope();
  const doSet = useAtomSet(setSecret, { mode: "promise" });
  const secretIdInputId = useId();
  const secretNameInputId = useId();
  const secretValueInputId = useId();

  const secretName = nameOverride ?? props.suggestedName;
  const secretId = idOverride ?? (slugifyForSecretId(secretName) || "custom-header");

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
        },
        reactivityKeys: secretWriteKeys,
      });
      props.onCreated(secretId.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save secret");
      setSaving(false);
    }
  };

  return (
    <div className="bg-primary/[0.03] px-4 py-3 space-y-3">
      <p className="text-[11px] font-semibold text-primary tracking-wide uppercase">New secret</p>
      <FieldGroup className="gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor={secretNameInputId}>Label</FieldLabel>
            <Input
              id={secretNameInputId}
              value={secretName}
              onChange={(e) => setNameOverride((e.target as HTMLInputElement).value)}
              placeholder="API Token"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={secretIdInputId}>ID</FieldLabel>
            <Input
              id={secretIdInputId}
              value={secretId}
              onChange={(e) => setIdOverride((e.target as HTMLInputElement).value)}
              placeholder="my-api-token"
              className="font-mono"
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={secretValueInputId}>Value</FieldLabel>
          <div className="relative">
            <Input
              id={secretValueInputId}
              type="text"
              value={secretValue}
              onChange={(e) => setSecretValue((e.target as HTMLInputElement).value)}
              placeholder="paste your token or key…"
              className="pr-9 font-mono"
              style={
                secretRevealed ? undefined : ({ WebkitTextSecurity: "disc" } as CSSProperties)
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setSecretRevealed((revealed) => !revealed)}
              aria-label={secretRevealed ? "Hide secret value" : "Reveal secret value"}
            >
              <SecretVisibilityIcon revealed={secretRevealed} />
            </Button>
          </div>
          {error && <FieldError>{error}</FieldError>}
        </Field>
      </FieldGroup>
      <div className="flex justify-end gap-1.5 pt-0.5">
        <Button variant="outline" size="xs" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={handleSave}
          disabled={!secretId.trim() || !secretValue.trim() || saving}
        >
          {saving ? "Saving…" : "Create and use"}
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

function HeaderValuePreview(props: { headerName: string; secretId: string; prefix?: string }) {
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
    state.status === "revealed"
      ? state.value
      : state.status === "error"
        ? "failed to resolve"
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

// ---------------------------------------------------------------------------
// Header state helpers — shared by edit forms
// ---------------------------------------------------------------------------

export type HeaderState = {
  name: string;
  secretId: string | null;
  prefix?: string;
  presetKey?: string;
  fromPreset?: boolean;
};

export function matchPresetKey(name: string, prefix?: string): string {
  const preset =
    defaultHeaderAuthPresets.find((p) => p.name === name && p.prefix === prefix) ??
    defaultHeaderAuthPresets.find((p) => p.name === name && p.prefix === undefined);
  return preset?.key ?? "custom";
}

export function headerValueToState(
  name: string,
  value: { secretId: string; prefix?: string } | string,
): HeaderState {
  if (typeof value === "string") {
    return { name, secretId: null, presetKey: matchPresetKey(name, undefined) };
  }
  return {
    name,
    secretId: value.secretId,
    prefix: value.prefix,
    presetKey: matchPresetKey(name, value.prefix),
  };
}

export function headersFromState(
  entries: readonly HeaderState[],
): Record<string, { secretId: string; prefix?: string }> {
  const result: Record<string, { secretId: string; prefix?: string }> = {};
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name || !entry.secretId) continue;
    result[name] = {
      secretId: entry.secretId,
      ...(entry.prefix ? { prefix: entry.prefix } : {}),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Secret header auth row
// ---------------------------------------------------------------------------

export function SecretHeaderAuthRow(props: {
  name: string;
  prefix?: string;
  presetKey?: string;
  secretId: string | null;
  onChange: (update: { name: string; prefix?: string; presetKey?: string }) => void;
  onSelectSecret: (secretId: string) => void;
  existingSecrets: readonly SecretPickerSecret[];
  onRemove?: () => void;
  removeLabel?: string;
  label?: string;
  /**
   * Display name of the source this header belongs to (e.g. "Axiom"). Used
   * to prefix the suggested secret label and ID so tokens from different
   * sources don't collide on ids like `authorization`.
   */
  sourceName?: string;
}) {
  const [creating, setCreating] = useState(false);
  const nameInputId = useId();
  const prefixInputId = useId();
  const {
    name,
    prefix,
    presetKey,
    secretId,
    onChange,
    onSelectSecret,
    existingSecrets,
    onRemove,
    removeLabel = "Remove",
    label = "Header",
    sourceName,
  } = props;

  const isCustom = presetKey === "custom" || presetKey === undefined;
  const headerLabel = name.trim() || "Custom Header";
  const suggestedName = [sourceName?.trim(), headerLabel].filter(Boolean).join(" ");
  const suggestedId = slugifyForSecretId(suggestedName) || "custom-header";

  if (creating) {
    return (
      <InlineCreateSecret
        suggestedId={suggestedId}
        suggestedName={suggestedName}
        onCreated={(id) => {
          onSelectSecret(id);
          setCreating(false);
        }}
        onCancel={() => setCreating(false)}
      />
    );
  }

  return (
    <div className="space-y-2.5 px-4 py-3">
      <div className="flex w-full items-center justify-between gap-4">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        {onRemove && (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemove}
          >
            {removeLabel}
          </Button>
        )}
      </div>

      <FieldGroup className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor={nameInputId}>Name</FieldLabel>
          <Input
            id={nameInputId}
            value={name}
            onChange={(e) =>
              onChange({
                name: (e.target as HTMLInputElement).value,
                prefix,
                presetKey: isCustom ? "custom" : presetKey,
              })
            }
            placeholder="Authorization"
            className="font-mono"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={prefixInputId}>
            Prefix <span className="font-normal text-muted-foreground/60">(optional)</span>
          </FieldLabel>
          <Input
            id={prefixInputId}
            value={prefix ?? ""}
            onChange={(e) =>
              onChange({
                name,
                prefix: (e.target as HTMLInputElement).value || undefined,
                presetKey: isCustom ? "custom" : presetKey,
              })
            }
            placeholder="Bearer "
            className="font-mono"
          />
        </Field>
      </FieldGroup>

      <SecretPicker
        value={secretId}
        onSelect={onSelectSecret}
        secrets={existingSecrets}
        onCreateNew={() => setCreating(true)}
      />

      {secretId && name.trim() && (
        <HeaderValuePreview headerName={name.trim()} secretId={secretId} prefix={prefix} />
      )}
    </div>
  );
}

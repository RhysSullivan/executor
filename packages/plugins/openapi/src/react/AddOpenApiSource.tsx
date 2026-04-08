import { useState, useEffect, useRef } from "react";
import { useAtomSet, useAtomValue, useAtomRefresh, Result } from "@effect-atom/atom-react";
import { Option } from "effect";

import { secretsAtom, setSecret, resolveSecret } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { SecretPicker, type SecretPickerSecret } from "@executor/react/plugins/secret-picker";
import { SecretId } from "@executor/core";
import { Button } from "@executor/react/components/button";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Textarea } from "@executor/react/components/textarea";
import { Badge } from "@executor/react/components/badge";
import { RadioGroup, RadioGroupItem } from "@executor/react/components/radio-group";
import { Spinner } from "@executor/react/components/spinner";
import { previewOpenApiSpec, addOpenApiSpec } from "./atoms";
import type { SpecPreview, HeaderPreset } from "../sdk/preview";
import type { HeaderValue } from "../sdk/types";

// ---------------------------------------------------------------------------
// Inline secret creation
// ---------------------------------------------------------------------------

function InlineCreateSecret(props: {
  headerName: string;
  suggestedId: string;
  onCreated: (secretId: string) => void;
  onCancel: () => void;
}) {
  const [secretId, setSecretId] = useState(props.suggestedId);
  const [secretName, setSecretName] = useState(props.headerName);
  const [secretValue, setSecretValue] = useState("");
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
        <Input
          type="password"
          value={secretValue}
          onChange={(e) => setSecretValue((e.target as HTMLInputElement).value)}
          placeholder="paste your token or key…"
          className="h-8 text-xs font-mono"
        />
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

// ---------------------------------------------------------------------------
// Header value preview — shows what the header will look like
// ---------------------------------------------------------------------------

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
        ) : isRevealed ? (
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
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header presets
// ---------------------------------------------------------------------------

const HEADER_PRESETS = [
  { key: "bearer", label: "Bearer Token", name: "Authorization", prefix: "Bearer " },
  { key: "basic", label: "Basic Auth", name: "Authorization", prefix: "Basic " },
  { key: "api-key", label: "API Key", name: "X-API-Key" },
  { key: "auth-token", label: "Auth Token", name: "X-Auth-Token" },
  { key: "access-token", label: "Access Token", name: "X-Access-Token" },
  { key: "cookie", label: "Cookie", name: "Cookie" },
  { key: "custom", label: "Custom", name: "" },
] as const;

// ---------------------------------------------------------------------------
// Custom header row — pick a preset, then pick a secret
// ---------------------------------------------------------------------------

function CustomHeaderRow(props: {
  name: string;
  prefix?: string;
  presetKey?: string;
  secretId: string | null;
  onChange: (update: { name: string; prefix?: string; presetKey?: string }) => void;
  onSelectSecret: (secretId: string) => void;
  onRemove: () => void;
  existingSecrets: readonly SecretPickerSecret[];
}) {
  const [creating, setCreating] = useState(false);
  const { name, prefix, presetKey, secretId, onChange, onSelectSecret, onRemove, existingSecrets } = props;

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
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Header</Label>
        <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={onRemove}>
          Remove
        </Button>
      </div>

      {/* Preset chips */}
      <div className="flex flex-wrap gap-1">
        {HEADER_PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() =>
              onChange({
                name: p.name,
                prefix: (p as { prefix?: string }).prefix,
                presetKey: p.key,
              })
            }
            className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
              presetKey === p.key
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:text-foreground hover:bg-accent/50"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Name + prefix fields — always visible once a preset is picked */}
      {presetKey !== undefined && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Name</Label>
            <Input
              value={name}
              onChange={(e) => onChange({ name: (e.target as HTMLInputElement).value, prefix, presetKey: isCustom ? "custom" : presetKey })}
              placeholder="Authorization"
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Prefix <span className="normal-case tracking-normal font-normal text-muted-foreground/60">(opt.)</span></Label>
            <Input
              value={prefix ?? ""}
              onChange={(e) => onChange({ name, prefix: (e.target as HTMLInputElement).value || undefined, presetKey: isCustom ? "custom" : presetKey })}
              placeholder="Bearer "
              className="h-8 text-xs font-mono"
            />
          </div>
        </div>
      )}

      {/* Secret picker */}
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

      {/* Preview */}
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prefixForHeader(preset: HeaderPreset, headerName: string): string | undefined {
  const label = preset.label.toLowerCase();
  if (headerName.toLowerCase() === "authorization") {
    if (label.includes("bearer")) return "Bearer ";
    if (label.includes("basic")) return "Basic ";
  }
  return undefined;
}

function matchPresetKey(name: string, prefix?: string): string {
  if (name === "Authorization" && prefix === "Bearer ") return "bearer";
  if (name === "Authorization" && prefix === "Basic ") return "basic";
  if (name === "X-API-Key") return "api-key";
  if (name === "X-Auth-Token") return "auth-token";
  if (name === "X-Access-Token") return "access-token";
  if (name === "Cookie") return "cookie";
  return "custom";
}

function presetEntriesFromHeaderPreset(preset: HeaderPreset) {
  return preset.secretHeaders.map((headerName) => {
    const prefix = prefixForHeader(preset, headerName);
    return {
      name: headerName,
      secretId: null as string | null,
      prefix,
      presetKey: matchPresetKey(headerName, prefix),
      fromPreset: true,
    };
  });
}

// ---------------------------------------------------------------------------
// Main component — single progressive form
// ---------------------------------------------------------------------------

export default function AddOpenApiSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
}) {
  // Spec input
  const [specUrl, setSpecUrl] = useState(props.initialUrl ?? "");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // After analysis
  const [preview, setPreview] = useState<SpecPreview | null>(null);
  const [baseUrl, setBaseUrl] = useState("");

  // Auth
  const [presetIndex, setPresetIndex] = useState(0);
  const [customHeaders, setCustomHeaders] = useState<Array<{ name: string; secretId: string | null; prefix?: string; presetKey?: string; fromPreset?: boolean }>>([]);

  // Submit
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promise" });
  const doAdd = useAtomSet(addOpenApiSpec, { mode: "promise" });
  const secrets = useAtomValue(secretsAtom(scopeId));
  const autoAnalyzed = useRef(false);

  useEffect(() => {
    if (props.initialUrl && !autoAnalyzed.current) {
      autoAnalyzed.current = true;
      handleAnalyze();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const secretList: readonly SecretPickerSecret[] = Result.match(secrets, {
    onInitial: () => [] as SecretPickerSecret[],
    onFailure: () => [] as SecretPickerSecret[],
    onSuccess: ({ value }) =>
      value.map((s) => ({
        id: s.id,
        name: s.name,
        provider: s.provider ? String(s.provider) : undefined,
      })),
  });

  // ---- Derived state ----

  const presets = preview?.headerPresets ?? [];
  const hasAuth = presets.length > 0;
  const servers = (preview?.servers ?? []) as Array<{ url?: string }>;

  const allHeaders: Record<string, HeaderValue> = {};
  for (const ch of customHeaders) {
    if (ch.name.trim() && ch.secretId) {
      allHeaders[ch.name.trim()] = { secretId: ch.secretId, ...(ch.prefix ? { prefix: ch.prefix } : {}) };
    }
  }
  const hasHeaders = Object.keys(allHeaders).length > 0;

  const customHeadersValid = customHeaders.every(
    (ch) => ch.name.trim() && ch.secretId,
  );

  const canAdd =
    preview !== null &&
    baseUrl.trim().length > 0 &&
    (customHeaders.length === 0 || customHeadersValid);

  // ---- Handlers ----

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    setAddError(null);
    try {
      const result = await doPreview({
        path: { scopeId },
        payload: { spec: specUrl },
      });
      setPreview(result);

      const firstUrl = (result.servers as Array<{ url?: string }>)?.[0]?.url;
      if (firstUrl) setBaseUrl(firstUrl);

      const newPresetIndex = result.headerPresets.length > 0 ? 0 : -1;
      setPresetIndex(newPresetIndex);
      setCustomHeaders(
        newPresetIndex >= 0
          ? presetEntriesFromHeaderPreset(result.headerPresets[newPresetIndex])
          : [],
      );
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : "Failed to parse spec");
    } finally {
      setAnalyzing(false);
    }
  };

  const selectPreset = (index: number) => {
    setPresetIndex(index);
    if (index === -1) {
      // "None" — clear everything
      setCustomHeaders([]);
    } else if (index === -2) {
      // "Custom" — keep user headers, drop preset-derived, seed if empty
      const userHeaders = customHeaders.filter((h) => !h.fromPreset);
      setCustomHeaders(userHeaders.length > 0 ? userHeaders : [{ name: "", secretId: null, presetKey: undefined }]);
    } else {
      // Preset strategy — replace preset-derived headers, keep user headers
      const preset = presets[index];
      const userHeaders = customHeaders.filter((h) => !h.fromPreset);
      setCustomHeaders(preset ? [...presetEntriesFromHeaderPreset(preset), ...userHeaders] : userHeaders);
    }
  };

  const addCustomHeader = () => {
    if (presetIndex === -1) setPresetIndex(-2);
    setCustomHeaders([...customHeaders, { name: "", secretId: null, presetKey: undefined }]);
  };

  const updateCustomHeader = (index: number, update: Partial<{ name: string; secretId: string | null; prefix?: string; presetKey?: string }>) => {
    setCustomHeaders(customHeaders.map((ch, i) => (i === index ? { ...ch, ...update } : ch)));
  };

  const removeCustomHeader = (index: number) => {
    setCustomHeaders(customHeaders.filter((_, i) => i !== index));
  };

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    try {
      await doAdd({
        path: { scopeId },
        payload: {
          spec: specUrl,
          baseUrl: baseUrl.trim() || undefined,
          ...(hasHeaders ? { headers: allHeaders } : {}),
        },
      });
      props.onComplete();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    }
  };

  // ---- Render ----

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-foreground">Add OpenAPI Source</h1>

      {/* ── Spec input ── */}
      <section className="space-y-2">
        <Label>OpenAPI Spec</Label>
        <Textarea
          value={specUrl}
          onChange={(e) => {
            setSpecUrl((e.target as HTMLTextAreaElement).value);
            if (preview) {
              setPreview(null);
              setBaseUrl("");
              setCustomHeaders([]);
            }
          }}
          placeholder="https://api.example.com/openapi.json"
          rows={3}
          className="font-mono text-sm"
        />

        {analyzeError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <p className="text-[12px] text-destructive">{analyzeError}</p>
          </div>
        )}

        {!preview && (
          <div className="flex items-center justify-between">
            <p className="text-[12px] text-muted-foreground">
              Paste a URL or raw JSON/YAML content.
            </p>
            <Button
              disabled={!specUrl.trim() || analyzing}
              onClick={handleAnalyze}
            >
              {analyzing && <Spinner className="size-3.5" />}
              {analyzing ? "Analyzing…" : "Analyze"}
            </Button>
          </div>
        )}
      </section>

      {/* ── Everything below appears after analysis ── */}
      {preview && (
        <>
          {/* API info */}
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-card-foreground leading-none truncate">
                {Option.getOrElse(preview.title, () => "API")}
              </p>
              <p className="mt-1 text-[12px] text-muted-foreground leading-none">
                {Option.getOrElse(preview.version, () => "")}
                {Option.isSome(preview.version) && " · "}
                {preview.operationCount} operation{preview.operationCount !== 1 ? "s" : ""}
                {preview.tags.length > 0 && ` · ${preview.tags.length} tag${preview.tags.length !== 1 ? "s" : ""}`}
              </p>
            </div>
            {preview.tags.length > 0 && (
              <div className="hidden sm:flex flex-wrap gap-1 max-w-[200px] justify-end">
                {preview.tags.slice(0, 4).map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
                {preview.tags.length > 4 && (
                  <span className="text-[10px] text-muted-foreground">+{preview.tags.length - 4}</span>
                )}
              </div>
            )}
          </div>

          {/* Base URL */}
          <section className="space-y-2">
            <Label>Base URL</Label>

            {servers.length > 1 ? (
              <div className="space-y-2">
                <RadioGroup
                  value={baseUrl}
                  onValueChange={setBaseUrl}
                  className="gap-1.5"
                >
                  {servers.map((s, i) => {
                    const url = s.url ?? "";
                    return (
                      <label
                        key={i}
                        className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                          baseUrl === url
                            ? "border-primary/50 bg-primary/[0.03]"
                            : "border-border hover:bg-accent/50"
                        }`}
                      >
                        <RadioGroupItem value={url} />
                        <span className="font-mono text-xs text-foreground truncate">{url}</span>
                      </label>
                    );
                  })}
                </RadioGroup>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
                  placeholder="Or enter a custom URL…"
                  className="font-mono text-sm"
                />
              </div>
            ) : (
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
                placeholder="https://api.example.com"
                className="font-mono text-sm"
              />
            )}

            {!baseUrl.trim() && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                A base URL is required to make requests.
              </p>
            )}
          </section>

          {/* Authentication */}
          <section className="space-y-2.5">
            <Label>Authentication</Label>

            {/* Strategy picker */}
            {hasAuth && (
              <RadioGroup
                value={String(presetIndex)}
                onValueChange={(v) => selectPreset(Number(v))}
                className="gap-1.5"
              >
                {presets.map((preset, i) => (
                  <label
                    key={i}
                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      presetIndex === i
                        ? "border-primary/50 bg-primary/[0.03]"
                        : "border-border hover:bg-accent/50"
                    }`}
                  >
                    <RadioGroupItem value={String(i)} />
                    <span className="text-xs font-medium text-foreground">{preset.label}</span>
                    {preset.secretHeaders.length > 0 && (
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {preset.secretHeaders.length} header{preset.secretHeaders.length > 1 ? "s" : ""}
                      </span>
                    )}
                  </label>
                ))}

                <label
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    presetIndex === -2
                      ? "border-primary/50 bg-primary/[0.03]"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <RadioGroupItem value="-2" />
                  <span className="text-xs font-medium text-foreground">Custom</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">configure manually</span>
                </label>

                <label
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    presetIndex === -1
                      ? "border-primary/50 bg-primary/[0.03]"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <RadioGroupItem value="-1" />
                  <span className="text-xs font-medium text-foreground">None</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">skip auth</span>
                </label>
              </RadioGroup>
            )}

            {/* All headers — preset-derived and user-added (hidden when None) */}
            {presetIndex !== -1 && customHeaders.length > 0 && (
              <div className="space-y-2">
                {customHeaders.map((ch, i) => (
                  <CustomHeaderRow
                    key={i}
                    name={ch.name}
                    prefix={ch.prefix}
                    presetKey={ch.presetKey}
                    secretId={ch.secretId}
                    onChange={(update) => updateCustomHeader(i, update)}
                    onSelectSecret={(secretId) => updateCustomHeader(i, { secretId })}
                    onRemove={() => removeCustomHeader(i)}
                    existingSecrets={secretList}
                  />
                ))}
              </div>
            )}

            {(!hasAuth || presetIndex === -2) && (
              <Button
                variant="outline"
                size="sm"
                className="w-full border-dashed"
                onClick={addCustomHeader}
              >
                + Add header
              </Button>
            )}
          </section>

          {/* Add error */}
          {addError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive">{addError}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between border-t border-border pt-4">
            <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={!canAdd || adding}>
              {adding && <Spinner className="size-3.5" />}
              {adding ? "Adding…" : "Add source"}
            </Button>
          </div>
        </>
      )}

      {/* Cancel when no preview yet */}
      {!preview && (
        <div className="flex items-center justify-between pt-1">
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <div />
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { useAtomSet } from "@effect-atom/atom-react";
import { Option } from "effect";

import { useScope } from "@executor/react/api/scope-context";
import {
  SecretHeaderAuthRow,
  defaultHeaderAuthPresets,
} from "@executor/react/plugins/secret-header-auth";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
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
  const preset =
    defaultHeaderAuthPresets.find((entry) => entry.name === name && entry.prefix === prefix) ??
    defaultHeaderAuthPresets.find((entry) => entry.name === name && entry.prefix === undefined);

  return preset?.key ?? "custom";
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
  initialNamespace?: string;
}) {
  // Spec input
  const [specUrl, setSpecUrl] = useState(props.initialUrl ?? "");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // After analysis
  const [preview, setPreview] = useState<SpecPreview | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [namespace, setNamespace] = useState(props.initialNamespace ?? "");
  const [sourceName, setSourceName] = useState("");

  // Auth
  const [presetIndex, setPresetIndex] = useState(0);
  const [customHeaders, setCustomHeaders] = useState<
    Array<{
      name: string;
      secretId: string | null;
      prefix?: string;
      presetKey?: string;
      fromPreset?: boolean;
    }>
  >([]);

  // Submit
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promise" });
  const doAdd = useAtomSet(addOpenApiSpec, { mode: "promise" });
  const secretList = useSecretPickerSecrets();
  const autoAnalyzed = useRef(false);

  useEffect(() => {
    if (props.initialUrl && !autoAnalyzed.current) {
      autoAnalyzed.current = true;
      handleAnalyze();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Derived state ----

  const presets = preview?.headerPresets ?? [];
  const hasAuth = presets.length > 0;
  const servers = (preview?.servers ?? []) as Array<{ url?: string }>;

  const allHeaders: Record<string, HeaderValue> = {};
  for (const ch of customHeaders) {
    if (ch.name.trim() && ch.secretId) {
      allHeaders[ch.name.trim()] = {
        secretId: ch.secretId,
        ...(ch.prefix ? { prefix: ch.prefix } : {}),
      };
    }
  }
  const hasHeaders = Object.keys(allHeaders).length > 0;

  const customHeadersValid = customHeaders.every((ch) => ch.name.trim() && ch.secretId);

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

      // Derive defaults from the title
      const title = Option.getOrElse(result.title, () => "api");
      if (!sourceName) setSourceName(title);
      if (!props.initialNamespace) {
        setNamespace(
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "") || "api",
        );
      }

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
      setCustomHeaders(
        userHeaders.length > 0 ? userHeaders : [{ name: "", secretId: null, presetKey: undefined }],
      );
    } else {
      // Preset strategy — replace preset-derived headers, keep user headers
      const preset = presets[index];
      const userHeaders = customHeaders.filter((h) => !h.fromPreset);
      setCustomHeaders(
        preset ? [...presetEntriesFromHeaderPreset(preset), ...userHeaders] : userHeaders,
      );
    }
  };

  const addCustomHeader = () => {
    if (presetIndex === -1) setPresetIndex(-2);
    setCustomHeaders([...customHeaders, { name: "", secretId: null, presetKey: undefined }]);
  };

  const updateCustomHeader = (
    index: number,
    update: Partial<{ name: string; secretId: string | null; prefix?: string; presetKey?: string }>,
  ) => {
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
          name: sourceName.trim() || undefined,
          namespace: namespace.trim() || undefined,
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
            <Button disabled={!specUrl.trim() || analyzing} onClick={handleAnalyze}>
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
                {preview.tags.length > 0 &&
                  ` · ${preview.tags.length} tag${preview.tags.length !== 1 ? "s" : ""}`}
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
                  <span className="text-[10px] text-muted-foreground">
                    +{preview.tags.length - 4}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Name */}
          <section className="space-y-2">
            <Label>Name</Label>
            <Input
              value={sourceName}
              onChange={(e) => setSourceName((e.target as HTMLInputElement).value)}
              placeholder="e.g. Sentry API"
              className="text-[0.8125rem]"
            />
          </section>

          {/* Namespace */}
          <section className="space-y-2">
            <Label>Namespace</Label>
            <Input
              value={namespace}
              onChange={(e) =>
                setNamespace(
                  (e.target as HTMLInputElement).value.toLowerCase().replace(/[^a-z0-9_-]/g, "_"),
                )
              }
              placeholder="e.g. sentry, stripe, github"
              className="font-mono text-[0.8125rem]"
            />
            <p className="text-[0.75rem] text-muted-foreground">
              Unique identifier for this source. Used in tool names.
            </p>
          </section>

          {/* Base URL */}
          <section className="space-y-2">
            <Label>Base URL</Label>

            {servers.length > 1 ? (
              <div className="space-y-2">
                <RadioGroup value={baseUrl} onValueChange={setBaseUrl} className="gap-1.5">
                  {servers.map((s, i) => {
                    const url = s.url ?? "";
                    return (
                      <Label
                        key={i}
                        className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                          baseUrl === url
                            ? "border-primary/50 bg-primary/[0.03]"
                            : "border-border hover:bg-accent/50"
                        }`}
                      >
                        <RadioGroupItem value={url} />
                        <span className="font-mono text-xs text-foreground truncate">{url}</span>
                      </Label>
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
                  <Label
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
                        {preset.secretHeaders.length} header
                        {preset.secretHeaders.length > 1 ? "s" : ""}
                      </span>
                    )}
                  </Label>
                ))}

                <Label
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    presetIndex === -2
                      ? "border-primary/50 bg-primary/[0.03]"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <RadioGroupItem value="-2" />
                  <span className="text-xs font-medium text-foreground">Custom</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    configure manually
                  </span>
                </Label>

                <Label
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    presetIndex === -1
                      ? "border-primary/50 bg-primary/[0.03]"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <RadioGroupItem value="-1" />
                  <span className="text-xs font-medium text-foreground">None</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">skip auth</span>
                </Label>
              </RadioGroup>
            )}

            {/* All headers — preset-derived and user-added (hidden when None) */}
            {presetIndex !== -1 && customHeaders.length > 0 && (
              <div className="space-y-2">
                {customHeaders.map((ch, i) => (
                  <SecretHeaderAuthRow
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

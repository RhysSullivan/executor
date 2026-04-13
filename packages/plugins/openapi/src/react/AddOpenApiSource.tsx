import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";
import { Option } from "effect";

import { useScope } from "@executor/react/api/scope-context";
import { HeadersList } from "@executor/react/plugins/headers-list";
import {
  matchPresetKey,
  type HeaderState,
} from "@executor/react/plugins/secret-header-auth";
import {
  slugifyNamespace,
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryField,
  CardStackEntryTitle,
} from "@executor/react/components/card-stack";
import { FieldLabel } from "@executor/react/components/field";
import { FloatActions } from "@executor/react/components/float-actions";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Textarea } from "@executor/react/components/textarea";
import { RadioGroup, RadioGroupItem } from "@executor/react/components/radio-group";
import { Skeleton } from "@executor/react/components/skeleton";
import { IOSSpinner, Spinner } from "@executor/react/components/spinner";
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

function entriesFromSpecPreset(preset: HeaderPreset): HeaderState[] {
  return preset.secretHeaders.map((headerName) => {
    const prefix = prefixForHeader(preset, headerName);
    return {
      name: headerName,
      secretId: null,
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
  const identity = useSourceIdentity({
    fallbackName: preview ? Option.getOrElse(preview.title, () => "") : "",
    fallbackNamespace: props.initialNamespace,
  });

  // Auth
  // `selectedStrategy` is an index into `preview.headerPresets`, or -1 for
  // "None", or -2 for "Custom" (user-managed headers, no spec preset).
  const [selectedStrategy, setSelectedStrategy] = useState<number>(-1);
  const [customHeaders, setCustomHeaders] = useState<HeaderState[]>([]);

  // Submit
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promise" });
  const doAdd = useAtomSet(addOpenApiSpec, { mode: "promise" });
  const secretList = useSecretPickerSecrets();

  // Keep the latest handleAnalyze in a ref so the debounced effect doesn't
  // need it as a dependency (it closes over fresh state).
  const handleAnalyzeRef = useRef<() => void>(() => {});

  // Auto-analyze whenever the spec input changes, with a short debounce so
  // typing/pasting doesn't fire a request on every keystroke.
  useEffect(() => {
    const trimmed = specUrl.trim();
    if (!trimmed) return;
    if (preview) return;
    const handle = setTimeout(() => {
      handleAnalyzeRef.current();
    }, 400);
    return () => clearTimeout(handle);
  }, [specUrl, preview]);

  // ---- Derived state ----

  const servers = (preview?.servers ?? []) as Array<{ url?: string }>;

  // Derive a favicon URL from the spec URL (if the user entered one — raw
  // JSON/YAML content will fail URL parsing and yield null). Uses Google's
  // favicon service so we don't depend on the domain serving /favicon.ico.
  const faviconUrl = useMemo(() => {
    try {
      const trimmed = specUrl.trim();
      if (!trimmed) return null;
      const u = new URL(trimmed);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
    } catch {
      return null;
    }
  }, [specUrl]);

  const [faviconFailed, setFaviconFailed] = useState(false);
  useEffect(() => {
    setFaviconFailed(false);
  }, [faviconUrl]);

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

      const firstUrl = (result.servers as Array<{ url?: string }>)?.[0]?.url;
      if (firstUrl) setBaseUrl(firstUrl);

      const firstPreset = result.headerPresets[0];
      if (firstPreset) {
        setSelectedStrategy(0);
        setCustomHeaders(entriesFromSpecPreset(firstPreset));
      } else {
        setSelectedStrategy(-1);
        setCustomHeaders([]);
      }
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : "Failed to parse spec");
    } finally {
      setAnalyzing(false);
    }
  };

  handleAnalyzeRef.current = handleAnalyze;

  const selectStrategy = (index: number) => {
    setSelectedStrategy(index);
    if (index === -1) {
      setCustomHeaders([]);
      return;
    }
    if (index === -2) {
      // Drop preset-derived headers, keep user headers (seed one if empty).
      const userHeaders = customHeaders.filter((h) => !h.fromPreset);
      setCustomHeaders(userHeaders.length > 0 ? userHeaders : []);
      return;
    }
    const preset = preview?.headerPresets[index];
    if (!preset) return;
    const userHeaders = customHeaders.filter((h) => !h.fromPreset);
    setCustomHeaders([...entriesFromSpecPreset(preset), ...userHeaders]);
  };

  const handleHeadersChange = (next: HeaderState[]) => {
    setCustomHeaders(next);
    // If user drops all preset-derived headers and adds their own, mark as
    // Custom so the strategy picker reflects it.
    if (selectedStrategy >= 0 && next.every((h) => !h.fromPreset)) {
      setSelectedStrategy(next.length === 0 ? -1 : -2);
    }
  };

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    try {
      await doAdd({
        path: { scopeId },
        payload: {
          spec: specUrl,
          name: identity.name.trim() || undefined,
          namespace: slugifyNamespace(identity.namespace) || undefined,
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
    <div className="flex flex-1 flex-col gap-6">
      <h1 className="text-xl font-semibold text-foreground">Add OpenAPI Source</h1>

      {/* ── Spec input ── */}
      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField
            label="OpenAPI Spec"
            hint={!preview ? "Paste a URL or raw JSON/YAML content." : undefined}
          >
            <div className="relative">
              <Textarea
                value={specUrl}
                onChange={(e) => {
                  setSpecUrl((e.target as HTMLTextAreaElement).value);
                  if (preview) {
                    setPreview(null);
                    setBaseUrl("");
                    setCustomHeaders([]);
                    setSelectedStrategy(-1);
                  }
                }}
                placeholder="https://api.example.com/openapi.json"
                rows={3}
                maxRows={10}
                className="font-mono text-sm"
              />
              {analyzing && (
                <div className="pointer-events-none absolute right-2 top-2">
                  <IOSSpinner className="size-4" />
                </div>
              )}
            </div>
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      {/* ── Title card (shown below spec input after analysis) ── */}
      {preview ? (
        <CardStack>
          <CardStackContent className="border-t-0">
            <CardStackEntry>
              {faviconUrl && !faviconFailed && (
                <img
                  src={faviconUrl}
                  alt=""
                  className="size-4 shrink-0 object-contain"
                  onError={() => setFaviconFailed(true)}
                />
              )}
              <CardStackEntryContent>
                <CardStackEntryTitle>
                  {Option.getOrElse(preview.title, () => "API")}
                </CardStackEntryTitle>
                <CardStackEntryDescription>
                  {Option.getOrElse(preview.version, () => "")}
                  {Option.isSome(preview.version) && " · "}
                  {preview.operationCount} operation
                  {preview.operationCount !== 1 ? "s" : ""}
                  {preview.tags.length > 0 &&
                    ` · ${preview.tags.length} tag${preview.tags.length !== 1 ? "s" : ""}`}
                </CardStackEntryDescription>
              </CardStackEntryContent>
            </CardStackEntry>
          </CardStackContent>
        </CardStack>
      ) : analyzing ? (
        <CardStack>
          <CardStackContent className="border-t-0">
            <CardStackEntry>
              <Skeleton className="size-4 shrink-0 rounded" />
              <CardStackEntryContent>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-1 h-3 w-56" />
              </CardStackEntryContent>
            </CardStackEntry>
          </CardStackContent>
        </CardStack>
      ) : null}

      {analyzeError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{analyzeError}</p>
        </div>
      )}

      {/* ── Everything below appears after analysis ── */}
      {preview && (
        <>
          <SourceIdentityFields identity={identity} />

          {/* Base URL */}
          <CardStack>
            <CardStackContent className="border-t-0">
              <CardStackEntryField label="Base URL">
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
                            <span className="font-mono text-xs text-foreground truncate">
                              {url}
                            </span>
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
              </CardStackEntryField>
            </CardStackContent>
          </CardStack>

          <section className="space-y-2.5">
            <FieldLabel>Authentication</FieldLabel>
            {preview.headerPresets.length > 0 && (
              <RadioGroup
                value={String(selectedStrategy)}
                onValueChange={(value) => selectStrategy(Number(value))}
                className="gap-1.5"
              >
                {preview.headerPresets.map((preset, i) => (
                  <Label
                    key={i}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      selectedStrategy === i
                        ? "border-primary/50 bg-primary/[0.03]"
                        : "border-border hover:bg-accent/50"
                    }`}
                  >
                    <RadioGroupItem value={String(i)} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-foreground">{preset.label}</div>
                      {preset.secretHeaders.length > 0 && (
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {preset.secretHeaders.join(" · ")}
                        </div>
                      )}
                    </div>
                  </Label>
                ))}
                <Label
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    selectedStrategy === -2
                      ? "border-primary/50 bg-primary/[0.03]"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <RadioGroupItem value="-2" />
                  <span className="text-xs font-medium text-foreground">Custom</span>
                </Label>
                <Label
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    selectedStrategy === -1
                      ? "border-primary/50 bg-primary/[0.03]"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <RadioGroupItem value="-1" />
                  <span className="text-xs font-medium text-foreground">None</span>
                </Label>
              </RadioGroup>
            )}
            {(preview.headerPresets.length === 0 || selectedStrategy !== -1) && (
              <HeadersList
                headers={customHeaders}
                onHeadersChange={handleHeadersChange}
                existingSecrets={secretList}
              />
            )}
          </section>

          {/* Add error */}
          {addError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive">{addError}</p>
            </div>
          )}
        </>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        {preview && (
          <Button onClick={handleAdd} disabled={!canAdd || adding}>
            {adding && <Spinner className="size-3.5" />}
            {adding ? "Adding…" : "Add source"}
          </Button>
        )}
      </FloatActions>
    </div>
  );
}

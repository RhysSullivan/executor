import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";
import { Option } from "effect";

import { useScope } from "@executor/react/api/scope-context";
import { defaultHeaderAuthPresets } from "@executor/react/plugins/secret-header-auth";
import {
  AuthenticationSection,
  type AuthMethod,
} from "@executor/react/plugins/authentication-section";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryField,
  CardStackEntryTitle,
  CardStackHeader,
} from "@executor/react/components/card-stack";
import { FloatActions } from "@executor/react/components/float-actions";
import { cn } from "@executor/react/lib/utils";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Textarea } from "@executor/react/components/textarea";
import { Badge } from "@executor/react/components/badge";
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

function matchPresetKey(name: string, prefix?: string): string {
  const preset =
    defaultHeaderAuthPresets.find((entry) => entry.name === name && entry.prefix === prefix) ??
    defaultHeaderAuthPresets.find((entry) => entry.name === name && entry.prefix === undefined);

  return preset?.key ?? "custom";
}

function methodBadgeClasses(method: string): string {
  switch (method) {
    case "get":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "post":
      return "bg-blue-500/10 text-blue-700 dark:text-blue-400";
    case "put":
    case "patch":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "delete":
      return "bg-red-500/10 text-red-600 dark:text-red-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function presetEntriesFromHeaderPreset(preset: HeaderPreset) {
  return preset.secretHeaders.map((headerName) => {
    const prefix = prefixForHeader(preset, headerName);
    return {
      name: headerName,
      secretId: null as string | null,
      prefix,
      presetKey: matchPresetKey(headerName, prefix),
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
  const [authMode, setAuthMode] = useState<AuthMethod>("none");
  const [customHeaders, setCustomHeaders] = useState<
    Array<{
      name: string;
      secretId: string | null;
      prefix?: string;
      presetKey?: string;
    }>
  >([]);

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

      const firstPreset = result.headerPresets[0];
      if (firstPreset) {
        setAuthMode("header");
        setCustomHeaders(presetEntriesFromHeaderPreset(firstPreset));
      } else {
        setAuthMode("none");
        setCustomHeaders([]);
      }
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : "Failed to parse spec");
    } finally {
      setAnalyzing(false);
    }
  };

  handleAnalyzeRef.current = handleAnalyze;

  const handleAuthModeChange = (mode: AuthMethod) => {
    setAuthMode(mode);
    if (mode === "none") {
      setCustomHeaders([]);
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
    <div className="flex flex-1 flex-col gap-6">
      <h1 className="text-xl font-semibold text-foreground">Add OpenAPI Source</h1>

      {/* ── Title card (shown above text area after analysis) ── */}
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
                    setAuthMode("none");
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

      {analyzeError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{analyzeError}</p>
        </div>
      )}

      {/* ── Everything below appears after analysis ── */}
      {preview && (
        <>
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

          <AuthenticationSection
            methods={["none", "header"]}
            value={authMode}
            onChange={handleAuthModeChange}
            headers={customHeaders}
            onHeadersChange={setCustomHeaders}
            existingSecrets={secretList}
          />

          {/* Operations */}
          {preview.operations.length > 0 && (
            <CardStack searchable className="opacity-50 hover:opacity-100 transition-opacity">
              <CardStackHeader>
                {preview.operations.length} operation
                {preview.operations.length !== 1 ? "s" : ""}
              </CardStackHeader>
              <CardStackContent>
                {preview.operations.map((op) => (
                  <CardStackEntry
                    key={op.operationId}
                    searchText={`${op.method} ${op.path} ${Option.getOrElse(op.summary, () => "")} ${op.tags.join(" ")}`}
                  >
                    <CardStackEntryContent>
                      <CardStackEntryTitle className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase",
                            methodBadgeClasses(op.method),
                          )}
                        >
                          {op.method}
                        </span>
                        <span className="truncate font-mono">{op.path}</span>
                      </CardStackEntryTitle>
                      {Option.isSome(op.summary) && (
                        <CardStackEntryDescription>{op.summary.value}</CardStackEntryDescription>
                      )}
                    </CardStackEntryContent>
                    {op.deprecated && (
                      <CardStackEntryActions>
                        <Badge variant="outline" className="text-[10px]">
                          Deprecated
                        </Badge>
                      </CardStackEntryActions>
                    )}
                  </CardStackEntry>
                ))}
              </CardStackContent>
            </CardStack>
          )}

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

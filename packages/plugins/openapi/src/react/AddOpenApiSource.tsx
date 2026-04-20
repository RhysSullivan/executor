import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";
import { Option } from "effect";

import { openOAuthPopup, type OAuthPopupResult } from "@executor/plugin-oauth2/react";

import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { usePendingSources } from "@executor/react/api/optimistic";
import { HeadersList } from "@executor/react/plugins/headers-list";
import {
  CreatableSecretPicker,
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
import { CopyButton } from "@executor/react/components/copy-button";
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
import {
  NativeSelect,
  NativeSelectOption,
} from "@executor/react/components/native-select";
import { Textarea } from "@executor/react/components/textarea";
import { Checkbox } from "@executor/react/components/checkbox";
import { SourceFavicon } from "@executor/react/components/source-favicon";
import { RadioGroup, RadioGroupItem } from "@executor/react/components/radio-group";
import { Skeleton } from "@executor/react/components/skeleton";
import { IOSSpinner, Spinner } from "@executor/react/components/spinner";
import {
  addOpenApiSpec,
  previewOpenApiSpec,
  startOpenApiOAuth,
} from "./atoms";
import type { SpecPreview, HeaderPreset, OAuth2Preset } from "../sdk/preview";
import {
  OAuth2Auth,
  type HeaderValue,
  type ServerInfo,
  type ServerVariable,
} from "../sdk/types";

export const OPENAPI_OAUTH_CHANNEL = "executor:openapi-oauth-result";
export const OPENAPI_OAUTH_POPUP_NAME = "openapi-oauth";
export const OPENAPI_OAUTH_CALLBACK_PATH = "/api/openapi/oauth/callback";

// Stable secret ids for the access/refresh tokens a given OAuth2 security
// scheme on a given source mints. The same ids must be passed into
// `startOAuth` AND stored on the source's `OAuth2Auth`, so at invoke time
// the per-user scope (which actually holds the token value) resolves via
// shadowing over the source-level reference. Keyed by source namespace +
// scheme name so a single spec can host multiple schemes without
// colliding, and so reconnecting OAuth overwrites the previous token
// rather than leaking orphaned secret rows.
const oauthTokenSecretIds = (
  namespaceSlug: string,
  securitySchemeName: string,
): { readonly accessTokenSecretId: string; readonly refreshTokenSecretId: string } => {
  const slugScheme = securitySchemeName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const prefix = `openapi_${namespaceSlug}_${slugScheme}`;
  return {
    accessTokenSecretId: `${prefix}_access_token`,
    refreshTokenSecretId: `${prefix}_refresh_token`,
  };
};

const substituteUrlVariables = (url: string, values: Record<string, string>): string => {
  let out = url;
  for (const [name, value] of Object.entries(values)) {
    out = out.replaceAll(`{${name}}`, value);
  }
  return out;
};

type StrategySelection =
  | { readonly kind: "none" }
  | { readonly kind: "custom" }
  | { readonly kind: "header"; readonly presetIndex: number }
  | { readonly kind: "oauth2"; readonly presetIndex: number };

const serializeStrategy = (s: StrategySelection): string => {
  switch (s.kind) {
    case "none":
      return "none";
    case "custom":
      return "custom";
    case "header":
      return `header:${s.presetIndex}`;
    case "oauth2":
      return `oauth2:${s.presetIndex}`;
  }
};

const parseStrategy = (value: string): StrategySelection => {
  if (value === "none") return { kind: "none" };
  if (value === "custom") return { kind: "custom" };
  if (value.startsWith("header:")) {
    return { kind: "header", presetIndex: Number(value.slice("header:".length)) };
  }
  if (value.startsWith("oauth2:")) {
    return { kind: "oauth2", presetIndex: Number(value.slice("oauth2:".length)) };
  }
  return { kind: "none" };
};

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
  // -1 means the user is entering a fully custom base URL (no server selected).
  const [selectedServerIndex, setSelectedServerIndex] = useState<number>(-1);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  // Variable selections for the currently selected server, keyed by variable name.
  const [variableSelections, setVariableSelections] = useState<Record<string, string>>({});
  const identity = useSourceIdentity({
    fallbackName: preview ? Option.getOrElse(preview.title, () => "") : "",
    fallbackNamespace: props.initialNamespace,
  });

  // Auth
  const [strategy, setStrategy] = useState<StrategySelection>({ kind: "none" });
  const [customHeaders, setCustomHeaders] = useState<HeaderState[]>([]);

  // OAuth2 state (only populated while an oauth2 preset is selected)
  const [oauth2ClientIdSecretId, setOauth2ClientIdSecretId] = useState<string | null>(null);
  const [oauth2ClientSecretSecretId, setOauth2ClientSecretSecretId] = useState<string | null>(
    null,
  );
  const [oauth2SelectedScopes, setOauth2SelectedScopes] = useState<Set<string>>(new Set());
  const [oauth2Auth, setOauth2Auth] = useState<OAuth2Auth | null>(null);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [oauth2Error, setOauth2Error] = useState<string | null>(null);
  const oauthCleanup = useRef<(() => void) | null>(null);

  // Submit
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promise" });
  const doAdd = useAtomSet(addOpenApiSpec, { mode: "promise" });
  const doStartOAuth = useAtomSet(startOpenApiOAuth, { mode: "promise" });
  const { beginAdd } = usePendingSources();
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

  const servers: readonly ServerInfo[] = preview?.servers ?? [];
  const selectedServer: ServerInfo | null =
    selectedServerIndex >= 0 ? (servers[selectedServerIndex] ?? null) : null;

  const serverVariables: Record<string, ServerVariable> = selectedServer
    ? Option.getOrElse(
        selectedServer.variables,
        () => ({}) as Record<string, ServerVariable>,
      )
    : {};
  const serverVariableEntries: Array<[string, ServerVariable]> =
    Object.entries(serverVariables);

  const resolvedBaseUrl =
    selectedServer !== null
      ? substituteUrlVariables(selectedServer.url, variableSelections)
      : customBaseUrl.trim();

  // Helper used by analyze + server selection: build a default selection map
  // from a server's variable defaults.
  const defaultSelectionsFor = (server: ServerInfo): Record<string, string> => {
    const vars: Record<string, ServerVariable> = Option.getOrElse(
      server.variables,
      () => ({}) as Record<string, ServerVariable>,
    );
    const out: Record<string, string> = {};
    for (const [name, v] of Object.entries(vars)) out[name] = v.default;
    return out;
  };

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

  const oauth2Presets: readonly OAuth2Preset[] = preview?.oauth2Presets ?? [];
  const oauth2RedirectUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${OPENAPI_OAUTH_CALLBACK_PATH}`
      : OPENAPI_OAUTH_CALLBACK_PATH;
  const selectedOAuth2Preset: OAuth2Preset | null =
    strategy.kind === "oauth2" ? (oauth2Presets[strategy.presetIndex] ?? null) : null;

  const oauth2Ready =
    strategy.kind !== "oauth2" || oauth2Auth !== null;

  const canAdd =
    preview !== null &&
    resolvedBaseUrl.length > 0 &&
    (customHeaders.length === 0 || customHeadersValid) &&
    oauth2Ready;

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

      const firstServer = result.servers[0];
      if (firstServer) {
        setSelectedServerIndex(0);
        setVariableSelections(defaultSelectionsFor(firstServer));
        setCustomBaseUrl("");
      } else {
        setSelectedServerIndex(-1);
        setVariableSelections({});
        setCustomBaseUrl("");
      }

      const firstPreset = result.headerPresets[0];
      if (firstPreset) {
        setStrategy({ kind: "header", presetIndex: 0 });
        setCustomHeaders(entriesFromSpecPreset(firstPreset));
      } else {
        setStrategy({ kind: "none" });
        setCustomHeaders([]);
      }
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : "Failed to parse spec");
    } finally {
      setAnalyzing(false);
    }
  };

  handleAnalyzeRef.current = handleAnalyze;

  const selectStrategy = (next: StrategySelection) => {
    setStrategy(next);
    // Clear any stale OAuth grant whenever the strategy changes away from oauth2.
    if (next.kind !== "oauth2") {
      setOauth2Auth(null);
      setOauth2Error(null);
    }
    switch (next.kind) {
      case "none":
        setCustomHeaders([]);
        return;
      case "custom": {
        const userHeaders = customHeaders.filter((h) => !h.fromPreset);
        setCustomHeaders(userHeaders.length > 0 ? userHeaders : []);
        return;
      }
      case "header": {
        const preset = preview?.headerPresets[next.presetIndex];
        if (!preset) return;
        const userHeaders = customHeaders.filter((h) => !h.fromPreset);
        setCustomHeaders([...entriesFromSpecPreset(preset), ...userHeaders]);
        return;
      }
      case "oauth2": {
        setCustomHeaders([]);
        const preset = preview?.oauth2Presets[next.presetIndex];
        if (preset) {
          setOauth2SelectedScopes(new Set(Object.keys(preset.scopes)));
        }
        return;
      }
    }
  };

  const handleHeadersChange = (next: HeaderState[]) => {
    setCustomHeaders(next);
    if (strategy.kind === "header" && next.every((h) => !h.fromPreset)) {
      setStrategy(next.length === 0 ? { kind: "none" } : { kind: "custom" });
    }
  };

  const toggleOAuth2Scope = (scope: string) => {
    setOauth2SelectedScopes((prev) => {
      const copy = new Set(prev);
      if (copy.has(scope)) copy.delete(scope);
      else copy.add(scope);
      return copy;
    });
    // Changing scopes invalidates any previously-granted token.
    setOauth2Auth(null);
  };

  const handleConnectOAuth2 = useCallback(async () => {
    if (!selectedOAuth2Preset || !oauth2ClientIdSecretId || !preview) return;
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    setStartingOAuth(true);
    setOauth2Error(null);
    try {
      const displayName =
        identity.name.trim() || selectedOAuth2Preset.securitySchemeName;

      const namespaceSlug =
        slugifyNamespace(identity.namespace) ||
        slugifyNamespace(Option.getOrElse(preview.title, () => "")) ||
        "openapi";
      const tokenIds = oauthTokenSecretIds(
        namespaceSlug,
        selectedOAuth2Preset.securitySchemeName,
      );

      if (selectedOAuth2Preset.flow === "clientCredentials") {
        // RFC 6749 §4.4: no user-interactive consent step. The client_secret
        // is mandatory; the backend exchanges tokens inline and returns a
        // completed OAuth2Auth we can attach to the source directly.
        if (!oauth2ClientSecretSecretId) {
          setStartingOAuth(false);
          setOauth2Error("client_credentials requires a client secret");
          return;
        }
        const response = await doStartOAuth({
          path: { scopeId },
          payload: {
            displayName,
            securitySchemeName: selectedOAuth2Preset.securitySchemeName,
            flow: "clientCredentials",
            tokenUrl: selectedOAuth2Preset.tokenUrl,
            clientIdSecretId: oauth2ClientIdSecretId,
            clientSecretSecretId: oauth2ClientSecretSecretId,
            scopes: [...oauth2SelectedScopes],
            accessTokenSecretId: tokenIds.accessTokenSecretId,
          },
        });
        setStartingOAuth(false);
        if (response.flow !== "clientCredentials") {
          setOauth2Error("Unexpected response flow from server");
          return;
        }
        setOauth2Auth(response.auth);
        setOauth2Error(null);
        return;
      }

      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          displayName,
          securitySchemeName: selectedOAuth2Preset.securitySchemeName,
          flow: "authorizationCode",
          authorizationUrl: Option.getOrElse(selectedOAuth2Preset.authorizationUrl, () => ""),
          tokenUrl: selectedOAuth2Preset.tokenUrl,
          redirectUrl: oauth2RedirectUrl,
          clientIdSecretId: oauth2ClientIdSecretId,
          clientSecretSecretId: oauth2ClientSecretSecretId,
          scopes: [...oauth2SelectedScopes],
          accessTokenSecretId: tokenIds.accessTokenSecretId,
          refreshTokenSecretId: tokenIds.refreshTokenSecretId,
        },
      });

      if (response.flow !== "authorizationCode") {
        setStartingOAuth(false);
        setOauth2Error("Unexpected response flow from server");
        return;
      }

      oauthCleanup.current = openOAuthPopup<OAuth2Auth>({
        url: response.authorizationUrl,
        popupName: OPENAPI_OAUTH_POPUP_NAME,
        channelName: OPENAPI_OAUTH_CHANNEL,
        onResult: (result: OAuthPopupResult<OAuth2Auth>) => {
          oauthCleanup.current = null;
          setStartingOAuth(false);
          if (result.ok) {
            // The popup payload is an OAuthPopupResult wrapping the
            // backend's OAuth2Auth descriptor; strip the envelope and
            // reconstruct the OAuth2Auth class instance for type safety.
            setOauth2Auth(
              new OAuth2Auth({
                kind: "oauth2",
                securitySchemeName: result.securitySchemeName,
                flow: result.flow,
                tokenUrl: result.tokenUrl,
                clientIdSecretId: result.clientIdSecretId,
                clientSecretSecretId: result.clientSecretSecretId,
                accessTokenSecretId: result.accessTokenSecretId,
                refreshTokenSecretId: result.refreshTokenSecretId,
                tokenType: result.tokenType,
                expiresAt: result.expiresAt,
                scope: result.scope,
                scopes: [...result.scopes],
              }),
            );
            setOauth2Error(null);
          } else {
            setOauth2Error(result.error);
          }
        },
        onClosed: () => {
          // User closed the popup without completing the flow.
          oauthCleanup.current = null;
          setStartingOAuth(false);
          setOauth2Error("OAuth cancelled — popup was closed before completing the flow.");
        },
        onOpenFailed: () => {
          oauthCleanup.current = null;
          setStartingOAuth(false);
          setOauth2Error("OAuth popup was blocked by the browser");
        },
      });
    } catch (e) {
      setStartingOAuth(false);
      setOauth2Error(e instanceof Error ? e.message : "Failed to start OAuth");
    }
  }, [
    selectedOAuth2Preset,
    oauth2ClientIdSecretId,
    oauth2ClientSecretSecretId,
    oauth2SelectedScopes,
    oauth2RedirectUrl,
    preview,
    doStartOAuth,
    scopeId,
    identity.name,
    identity.namespace,
  ]);

  const handleCancelOAuth2 = useCallback(() => {
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    setStartingOAuth(false);
    setOauth2Error(null);
  }, []);

  useEffect(() => () => oauthCleanup.current?.(), []);

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    const namespace =
      slugifyNamespace(identity.namespace) ||
      (preview ? Option.getOrElse(preview.title, () => "openapi") : "openapi");
    const displayName =
      identity.name.trim() ||
      (preview ? Option.getOrElse(preview.title, () => namespace) : namespace);
    const placeholder = beginAdd({
      id: namespace,
      name: displayName,
      kind: "openapi",
      url: resolvedBaseUrl || undefined,
    });
    try {
      await doAdd({
        path: { scopeId },
        payload: {
          spec: specUrl,
          name: identity.name.trim() || undefined,
          namespace: slugifyNamespace(identity.namespace) || undefined,
          baseUrl: resolvedBaseUrl || undefined,
          ...(hasHeaders ? { headers: allHeaders } : {}),
          ...(oauth2Auth ? { oauth2: oauth2Auth } : {}),
        },
        reactivityKeys: sourceWriteKeys,
      });
      props.onComplete();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    } finally {
      placeholder.done();
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
                    setSelectedServerIndex(-1);
                    setCustomBaseUrl("");
                    setVariableSelections({});
                    setCustomHeaders([]);
                    setStrategy({ kind: "none" });
                    setOauth2Auth(null);
                    setOauth2Error(null);
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
              {resolvedBaseUrl && <SourceFavicon url={resolvedBaseUrl} size={16} />}
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
                {servers.length >= 1 && (
                  <RadioGroup
                    value={String(selectedServerIndex)}
                    onValueChange={(value) => {
                      const idx = Number(value);
                      setSelectedServerIndex(idx);
                      if (idx >= 0) {
                        const s = servers[idx];
                        if (s) setVariableSelections(defaultSelectionsFor(s));
                      } else {
                        setVariableSelections({});
                      }
                    }}
                    className="gap-1.5"
                  >
                    {servers.map((s, i) => (
                      <Label
                        key={i}
                        className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                          selectedServerIndex === i
                            ? "border-primary/50 bg-primary/[0.03]"
                            : "border-border hover:bg-accent/50"
                        }`}
                      >
                        <RadioGroupItem value={String(i)} className="mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-xs text-foreground truncate">
                            {s.url}
                          </div>
                          {Option.isSome(s.description) && (
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              {s.description.value}
                            </div>
                          )}
                        </div>
                      </Label>
                    ))}
                    <Label
                      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                        selectedServerIndex === -1
                          ? "border-primary/50 bg-primary/[0.03]"
                          : "border-border hover:bg-accent/50"
                      }`}
                    >
                      <RadioGroupItem value="-1" />
                      <span className="text-xs font-medium text-foreground">Custom</span>
                    </Label>
                  </RadioGroup>
                )}

                {/* Per-variable pickers for the selected server */}
                {selectedServer && serverVariableEntries.length > 0 && (
                  <div className="mt-2 space-y-2 rounded-lg border border-border/60 bg-muted/20 p-2.5">
                    {serverVariableEntries.map(([name, variable]) => {
                      const enumValues: readonly string[] = Option.getOrElse(
                        variable.enum,
                        () => [] as readonly string[],
                      );
                      const current = variableSelections[name] ?? variable.default;
                      return (
                        <div key={name} className="space-y-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <Label className="font-mono text-[11px] text-foreground">
                              {`{${name}}`}
                            </Label>
                            {Option.isSome(variable.description) && (
                              <span className="text-[10px] text-muted-foreground truncate">
                                {variable.description.value}
                              </span>
                            )}
                          </div>
                          {enumValues.length > 0 ? (
                            <NativeSelect
                              value={current}
                              onChange={(e) =>
                                setVariableSelections((prev) => ({
                                  ...prev,
                                  [name]: (e.target as HTMLSelectElement).value,
                                }))
                              }
                            >
                              {enumValues.map((v) => (
                                <NativeSelectOption key={v} value={v}>
                                  {v}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          ) : (
                            <Input
                              value={current}
                              onChange={(e) =>
                                setVariableSelections((prev) => ({
                                  ...prev,
                                  [name]: (e.target as HTMLInputElement).value,
                                }))
                              }
                              className="font-mono text-xs"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {selectedServerIndex === -1 ? (
                  <Input
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl((e.target as HTMLInputElement).value)}
                    placeholder="https://api.example.com"
                    className="font-mono text-sm"
                  />
                ) : (
                  <div className="rounded-md bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {resolvedBaseUrl || "\u00A0"}
                  </div>
                )}

                {!resolvedBaseUrl && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    A base URL is required to make requests.
                  </p>
                )}
              </CardStackEntryField>
            </CardStackContent>
          </CardStack>

          <section className="space-y-2.5">
            <FieldLabel>Authentication</FieldLabel>
            {(preview.headerPresets.length > 0 || oauth2Presets.length > 0) && (
              <RadioGroup
                value={serializeStrategy(strategy)}
                onValueChange={(value) => selectStrategy(parseStrategy(value))}
                className="gap-1.5"
              >
                {preview.headerPresets.map((preset, i) => {
                  const selected =
                    strategy.kind === "header" && strategy.presetIndex === i;
                  return (
                    <Label
                      key={`header-${i}`}
                      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                        selected
                          ? "border-primary/50 bg-primary/[0.03]"
                          : "border-border hover:bg-accent/50"
                      }`}
                    >
                      <RadioGroupItem value={`header:${i}`} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-foreground">{preset.label}</div>
                        {preset.secretHeaders.length > 0 && (
                          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                            {preset.secretHeaders.join(" · ")}
                          </div>
                        )}
                      </div>
                    </Label>
                  );
                })}
                {oauth2Presets.map((preset, i) => {
                  const selected =
                    strategy.kind === "oauth2" && strategy.presetIndex === i;
                  const scopeCount = Object.keys(preset.scopes).length;
                  return (
                    <Label
                      key={`oauth2-${i}`}
                      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                        selected
                          ? "border-primary/50 bg-primary/[0.03]"
                          : "border-border hover:bg-accent/50"
                      }`}
                    >
                      <RadioGroupItem value={`oauth2:${i}`} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-foreground">{preset.label}</div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {scopeCount} scope{scopeCount === 1 ? "" : "s"}
                        </div>
                      </div>
                    </Label>
                  );
                })}
                <Label
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    strategy.kind === "custom"
                      ? "border-primary/50 bg-primary/[0.03]"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <RadioGroupItem value="custom" />
                  <span className="text-xs font-medium text-foreground">Custom</span>
                </Label>
                <Label
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    strategy.kind === "none"
                      ? "border-primary/50 bg-primary/[0.03]"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <RadioGroupItem value="none" />
                  <span className="text-xs font-medium text-foreground">None</span>
                </Label>
              </RadioGroup>
            )}

            {/* Header-based auth input */}
            {strategy.kind !== "none" && strategy.kind !== "oauth2" && (
              <HeadersList
                headers={customHeaders}
                onHeadersChange={handleHeadersChange}
                existingSecrets={secretList}
                sourceName={identity.name}
              />
            )}

            {/* OAuth2 configuration */}
            {selectedOAuth2Preset && (
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
                <div className="space-y-1.5">
                  <FieldLabel className="text-[11px]">
                    Redirect URL{" "}
                    <span className="text-muted-foreground">
                      · add this to your OAuth app's allowed redirects
                    </span>
                  </FieldLabel>
                  <div className="flex items-center gap-1 rounded-md border border-border bg-background/50 px-2.5 py-1.5 font-mono text-[11px]">
                    <span className="truncate flex-1 text-foreground">{oauth2RedirectUrl}</span>
                    <CopyButton value={oauth2RedirectUrl} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <FieldLabel className="text-[11px]">Client ID secret</FieldLabel>
                  <CreatableSecretPicker
                    value={oauth2ClientIdSecretId}
                    onSelect={(id: string) => {
                      setOauth2ClientIdSecretId(id);
                      setOauth2Auth(null);
                    }}
                    secrets={secretList}
                    sourceName={identity.name}
                    secretLabel="Client ID"
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel className="text-[11px]">
                    Client secret{" "}
                    <span className="text-muted-foreground">
                      · optional for public clients with PKCE
                    </span>
                  </FieldLabel>
                  <CreatableSecretPicker
                    value={oauth2ClientSecretSecretId}
                    onSelect={(id: string) => {
                      setOauth2ClientSecretSecretId(id);
                      setOauth2Auth(null);
                    }}
                    secrets={secretList}
                    sourceName={identity.name}
                    secretLabel="Client Secret"
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel className="text-[11px]">Scopes</FieldLabel>
                  <div className="space-y-1 rounded-md border border-border/50 bg-background/50 p-2">
                    {Object.keys(selectedOAuth2Preset.scopes).length === 0 ? (
                      <div className="text-[11px] italic text-muted-foreground">
                        No scopes declared by the spec.
                      </div>
                    ) : (
                      Object.entries(selectedOAuth2Preset.scopes).map(([scope, description]) => (
                        <Label
                          key={scope}
                          className="flex items-start gap-2 cursor-pointer py-1"
                        >
                          <Checkbox
                            checked={oauth2SelectedScopes.has(scope)}
                            onCheckedChange={() => toggleOAuth2Scope(scope)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-[11px] text-foreground">{scope}</div>
                            {description && (
                              <div className="text-[10px] text-muted-foreground">
                                {description}
                              </div>
                            )}
                          </div>
                        </Label>
                      ))
                    )}
                  </div>
                </div>

                {oauth2Auth ? (
                  <div className="flex items-center justify-between rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2">
                    <div className="text-[11px] text-green-700 dark:text-green-400">
                      Connected · {oauth2Auth.scopes.length} scope
                      {oauth2Auth.scopes.length === 1 ? "" : "s"} granted
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOauth2Auth(null)}
                    >
                      Disconnect
                    </Button>
                  </div>
                ) : startingOAuth ? (
                  <div className="flex items-center gap-2">
                    <div className="flex flex-1 items-center gap-2 rounded-md border border-border/60 bg-background/50 px-3 py-2 text-[11px] text-muted-foreground">
                      <Spinner className="size-3.5" />
                      Waiting for OAuth… complete the flow in the popup, or cancel to retry.
                    </div>
                    <Button variant="ghost" size="sm" onClick={handleCancelOAuth2}>
                      Cancel
                    </Button>
                    <Button variant="secondary" size="sm" onClick={handleConnectOAuth2}>
                      Retry
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={handleConnectOAuth2}
                    disabled={!oauth2ClientIdSecretId || resolvedBaseUrl.length === 0}
                    className="w-full"
                  >
                    Connect via OAuth
                  </Button>
                )}

                {oauth2Error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <p className="text-[11px] text-destructive">{oauth2Error}</p>
                  </div>
                )}
              </div>
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

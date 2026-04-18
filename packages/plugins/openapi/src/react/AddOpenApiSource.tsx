import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";
import { Option } from "effect";
import { Link } from "@tanstack/react-router";

import { openOAuthPopup, type OAuthPopupResult } from "@executor/plugin-oauth2/react";

import { SecretPicker } from "@executor/react/plugins/secret-picker";
import { useScope } from "@executor/react/api/scope-context";
import { SourceConfig, type AuthMode, type OAuthStatus } from "@executor/react/plugins/source-config";
import type { KeyValueEntry } from "@executor/react/plugins/key-value-list";
import {
  slugifyNamespace,
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import { SourceOperations, type OperationEntry } from "@executor/react/plugins/source-operations";
import { OperationDetail } from "@executor/react/components/operation-detail";
import { buildToolTypeScriptPreview } from "@executor/sdk";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@executor/react/components/breadcrumb";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { FieldLabel } from "@executor/react/components/field";
import { FloatActions } from "@executor/react/components/float-actions";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Checkbox } from "@executor/react/components/checkbox";
import { Skeleton } from "@executor/react/components/skeleton";
import { SourceHeader } from "@executor/react/components/source-header";
import { IOSSpinner, Spinner } from "@executor/react/components/spinner";
import { FilterTabs } from "@executor/react/components/filter-tabs";
import {
  addOpenApiSpec,
  probeOpenApiSpec,
  startOpenApiOAuth,
} from "./atoms";
import { supportedAuthModesFromSchemes, type SpecPreview, type OAuth2Preset } from "../sdk/preview";
import {
  OAuth2Auth,
  type HeaderValue,
  type ServerInfo,
  type ServerVariable,
} from "../sdk/types";

const OPENAPI_OAUTH_CHANNEL = "executor:openapi-oauth-result";
const OPENAPI_OAUTH_POPUP_NAME = "openapi-oauth";

const substituteUrlVariables = (url: string, values: Record<string, string>): string => {
  let out = url;
  for (const [name, value] of Object.entries(values)) {
    out = out.replaceAll(`{${name}}`, value);
  }
  return out;
};

/** Return a new Set with `value` toggled (removed if present, added otherwise). */
const toggleInSet = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};


// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AddOpenApiSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
  initialNamespace?: string;
}) {
  // Spec input
  const [endpoint, setEndpoint] = useState(props.initialUrl ?? "");
  const [probing, setProbing] = useState(Boolean(props.initialUrl?.trim()));
  const [error, setError] = useState<string | null>(null);

  // After probe
  const [probeResult, setProbeResult] = useState<SpecPreview | null>(null);
  const [selectedServerIndex, setSelectedServerIndex] = useState<number>(-1);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [variableSelections, setVariableSelections] = useState<Record<string, string>>({});
  const identity = useSourceIdentity({
    fallbackName: probeResult ? Option.getOrElse(probeResult.title, () => "") : "",
    fallbackNamespace: props.initialNamespace,
  });

  // Tab
  const [activeTab, setActiveTab] = useState<"settings" | "operations">("settings");

  // Auth
  const [authMode, setAuthMode] = useState<AuthMode>("bearer");
  const [bearerSecretId, setBearerSecretId] = useState<string | null>(null);
  const [headers, setHeaders] = useState<readonly KeyValueEntry[]>([]);

  // OAuth2 state
  const [oauth2ClientIdSecretId, setOauth2ClientIdSecretId] = useState<string | null>(null);
  const [oauth2ClientSecretSecretId, setOauth2ClientSecretSecretId] = useState<string | null>(null);
  const [oauth2SelectedScopes, setOauth2SelectedScopes] = useState<Set<string>>(new Set());
  const [oauth2Auth, setOauth2Auth] = useState<OAuth2Auth | null>(null);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [oauth2Error, setOauth2Error] = useState<string | null>(null);
  const oauthCleanup = useRef<(() => void) | null>(null);

  const oauthStatus: OAuthStatus = oauth2Auth
    ? { step: "authenticated" }
    : startingOAuth
      ? { step: "waiting" }
      : oauth2Error
        ? { step: "error", message: oauth2Error }
        : { step: "idle" };

  // Submit
  const [adding, setAdding] = useState(false);

  const scopeId = useScope();
  const doProbe = useAtomSet(probeOpenApiSpec, { mode: "promise" });
  const doAdd = useAtomSet(addOpenApiSpec, { mode: "promise" });
  const doStartOAuth = useAtomSet(startOpenApiOAuth, { mode: "promise" });
  const secretList = useSecretPickerSecrets();

  const didInitialProbeRef = useRef(false);

  // ---- Derived state ----

  const servers: readonly ServerInfo[] = probeResult?.servers ?? [];
  const selectedServer: ServerInfo | null =
    selectedServerIndex >= 0 ? (servers[selectedServerIndex] ?? null) : null;

  const resolvedBaseUrl =
    selectedServer !== null
      ? substituteUrlVariables(selectedServer.url, variableSelections)
      : customBaseUrl.trim();

  const defaultSelectionsFor = (server: ServerInfo): Record<string, string> => {
    const vars: Record<string, ServerVariable> = Option.getOrElse(
      server.variables,
      () => ({}) as Record<string, ServerVariable>,
    );
    const out: Record<string, string> = {};
    for (const [name, v] of Object.entries(vars)) out[name] = v.default;
    return out;
  };

  // Build headers payload
  const allHeaders: Record<string, HeaderValue> = {};
  if (authMode === "bearer" && bearerSecretId) {
    allHeaders["Authorization"] = { secretId: bearerSecretId, prefix: "Bearer " };
  }
  for (const entry of headers) {
    const name = entry.key.trim();
    if (!name || !entry.value) continue;
    if (entry.type === "secret") {
      allHeaders[name] = { secretId: entry.value };
    }
  }
  const hasHeaders = Object.keys(allHeaders).length > 0;

  const oauth2Presets: readonly OAuth2Preset[] = probeResult?.oauth2Presets ?? [];

  const disabledAuthModes = useMemo<readonly AuthMode[]>(() => {
    if (!probeResult) return [];
    const supported = supportedAuthModesFromSchemes(probeResult.securitySchemes);
    return (["basic", "apikey", "bearer", "oauth"] as const).filter(
      (m) => !supported.has(m),
    );
  }, [probeResult]);
  const selectedOAuth2Preset: OAuth2Preset | null =
    authMode === "oauth" && oauth2Presets.length > 0 ? (oauth2Presets[0] ?? null) : null;

  const oauth2Ready = authMode !== "oauth" || oauth2Auth !== null;
  const canAdd = probeResult !== null && resolvedBaseUrl.length > 0 && oauth2Ready;

  // Operations for the tab
  const operationEntries: OperationEntry[] = useMemo(() => {
    if (!probeResult) return [];
    return probeResult.operations.map((op) => {
      const inputSchema = Option.getOrUndefined(op.inputSchema);
      const outputSchema = Option.getOrUndefined(op.outputSchema);
      const hasSchemas = inputSchema !== undefined || outputSchema !== undefined;
      return {
        id: op.operationId,
        method: op.method,
        path: op.path,
        summary: Option.isSome(op.summary) ? op.summary.value : undefined,
        deprecated: op.deprecated,
        renderDetail: hasSchemas
          ? () => {
              const ts = buildToolTypeScriptPreview({
                inputSchema,
                outputSchema,
                defs: new Map(),
              });
              const definitions = Object.entries(ts.typeScriptDefinitions ?? {}).map(
                ([name, code]) => ({ name, code }),
              );
              return (
                <OperationDetail
                  data={{
                    inputSchema,
                    outputSchema,
                    inputTypeScript: ts.inputTypeScript
                      ? `type Input = ${ts.inputTypeScript}`
                      : null,
                    outputTypeScript: ts.outputTypeScript
                      ? `type Output = ${ts.outputTypeScript}`
                      : null,
                    definitions,
                  }}
                />
              );
            }
          : undefined,
      };
    });
  }, [probeResult]);

  // ---- Handlers ----

  const handleProbe = useCallback(
    async (spec: string) => {
      setProbing(true);
      setError(null);
      try {
        const result = await doProbe({
          path: { scopeId },
          payload: { spec },
        });
        setProbeResult(result);

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

        if (result.oauth2Presets.length > 0) {
          setAuthMode("oauth");
          setOauth2SelectedScopes(new Set(Object.keys(result.oauth2Presets[0].scopes)));
        } else {
          setAuthMode("bearer");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to parse spec");
      } finally {
        setProbing(false);
      }
    },
    [doProbe, scopeId],
  );

  useEffect(() => {
    const trimmed = endpoint.trim();
    if (!trimmed) return;
    if (probeResult) return;
    const delay = didInitialProbeRef.current ? 400 : 0;
    didInitialProbeRef.current = true;
    const handle = setTimeout(() => {
      handleProbe(trimmed);
    }, delay);
    return () => clearTimeout(handle);
  }, [endpoint, probeResult, handleProbe]);

  const handleAuthModeChange = (mode: AuthMode) => {
    setAuthMode(mode);
    if (mode !== "oauth") {
      setOauth2Auth(null);
      setOauth2Error(null);
    } else if (oauth2Presets.length > 0) {
      setOauth2SelectedScopes(new Set(Object.keys(oauth2Presets[0].scopes)));
    }
  };

  const toggleOAuth2Scope = (scope: string) => {
    setOauth2SelectedScopes((prev) => toggleInSet(prev, scope));
    setOauth2Auth(null);
  };

  const handleStartOAuth = useCallback(async () => {
    if (!selectedOAuth2Preset || !oauth2ClientIdSecretId || !probeResult) return;
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    setStartingOAuth(true);
    setOauth2Error(null);
    try {
      const displayName = identity.name.trim() || selectedOAuth2Preset.securitySchemeName;

      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          displayName,
          securitySchemeName: selectedOAuth2Preset.securitySchemeName,
          flow: "authorizationCode",
          authorizationUrl: Option.getOrElse(selectedOAuth2Preset.authorizationUrl, () => ""),
          tokenUrl: selectedOAuth2Preset.tokenUrl,
          redirectUrl: `${window.location.origin}/api/openapi/oauth/callback`,
          clientIdSecretId: oauth2ClientIdSecretId,
          clientSecretSecretId: oauth2ClientSecretSecretId,
          scopes: [...oauth2SelectedScopes],
        },
      });

      oauthCleanup.current = openOAuthPopup<OAuth2Auth>({
        url: response.authorizationUrl,
        popupName: OPENAPI_OAUTH_POPUP_NAME,
        channelName: OPENAPI_OAUTH_CHANNEL,
        onResult: (result: OAuthPopupResult<OAuth2Auth>) => {
          oauthCleanup.current = null;
          setStartingOAuth(false);
          if (result.ok) {
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
    probeResult,
    doStartOAuth,
    scopeId,
    identity.name,
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
    setError(null);
    try {
      await doAdd({
        path: { scopeId },
        payload: {
          spec: endpoint,
          name: identity.name.trim() || undefined,
          namespace: slugifyNamespace(identity.namespace) || undefined,
          baseUrl: resolvedBaseUrl || undefined,
          ...(hasHeaders ? { headers: allHeaders } : {}),
          ...(oauth2Auth ? { oauth2: oauth2Auth } : {}),
        },
      });
      props.onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    }
  };

  // ---- Render ----

  return (
    <div className="flex flex-1 flex-col gap-6">
      {/* Breadcrumb */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/">Sources</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Add OpenAPI</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Source Header (after probe) */}
      {probeResult && (
        <SourceHeader
          url={resolvedBaseUrl || endpoint}
          title={Option.getOrElse(probeResult.title, () => "API")}
          subtitle={Option.getOrElse(probeResult.version, () => undefined)}
        />
      )}

      {probing && (
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <div>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-1 h-3 w-24" />
          </div>
        </div>
      )}

      {/* Spec URL input (shown when no probe result yet) */}
      {!probeResult && !probing && (
        <CardStack>
          <CardStackContent className="border-t-0">
            <CardStackEntryField
              label="OpenAPI Spec"
              hint="Paste a URL or raw JSON/YAML content."
              labelAction={probing ? <IOSSpinner className="size-4" /> : undefined}
            >
              <Input
                value={endpoint}
                onChange={(e) => {
                  setEndpoint((e.target as HTMLInputElement).value);
                }}
                placeholder="https://api.example.com/openapi.json"
                className="font-mono text-sm"
              />
            </CardStackEntryField>
          </CardStackContent>
        </CardStack>
      )}

      {error && !probeResult && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{error}</p>
        </div>
      )}

      {/* Filter tabs: Settings / Operations */}
      {probeResult && (
        <>
          <FilterTabs
            tabs={[
              { label: "Settings", value: "settings" },
              { label: "Operations", value: "operations", count: probeResult.operationCount },
            ]}
            value={activeTab}
            onChange={setActiveTab}
          />

          {activeTab === "settings" && (
            <div className="space-y-6">
              {/* URL, Name, Namespace in one card stack */}
              <SourceIdentityFields
                identity={identity}
                endpoint={resolvedBaseUrl || customBaseUrl}
                onEndpointChange={(v) => {
                  setSelectedServerIndex(-1);
                  setVariableSelections({});
                  setCustomBaseUrl(v);
                }}
                endpointLabel="URL"
                endpointHints={servers.map((s, i) => ({
                  label: Option.getOrElse(s.description, () => `Server ${i + 1}`),
                  url: substituteUrlVariables(s.url, defaultSelectionsFor(s)),
                }))}
                endpointExtra={
                  !resolvedBaseUrl ? (
                    <p className="text-sm text-amber-600 dark:text-amber-400">
                      A base URL is required to make requests.
                    </p>
                  ) : undefined
                }
              />

              {/* Authorization + Headers */}
              <SourceConfig
                authMode={authMode}
                onAuthModeChange={handleAuthModeChange}
                disabledAuthModes={disabledAuthModes}
                bearerSecretId={bearerSecretId}
                onBearerSecretChange={setBearerSecretId}
                oauthStatus={oauthStatus}
                onOAuthSignIn={handleStartOAuth}
                onOAuthCancel={handleCancelOAuth2}
                oauthExtra={
                  selectedOAuth2Preset && (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <FieldLabel className="text-sm">Client ID secret</FieldLabel>
                        <SecretPicker
                          value={oauth2ClientIdSecretId}
                          onSelect={(id: string) => {
                            setOauth2ClientIdSecretId(id);
                            setOauth2Auth(null);
                          }}
                          secrets={secretList}
                          showChevron
                        />
                      </div>
                      <div className="space-y-1.5">
                        <FieldLabel className="text-sm">
                          Client secret{" "}
                          <span className="text-muted-foreground">
                            · optional for public clients with PKCE
                          </span>
                        </FieldLabel>
                        <SecretPicker
                          value={oauth2ClientSecretSecretId}
                          onSelect={(id: string) => {
                            setOauth2ClientSecretSecretId(id);
                            setOauth2Auth(null);
                          }}
                          secrets={secretList}
                          showChevron
                        />
                      </div>
                      <div className="space-y-1.5">
                        <FieldLabel className="text-sm">Scopes</FieldLabel>
                        <div className="space-y-1 rounded-md ring-1 ring-black/5 dark:ring-white/10 bg-background/50 p-2">
                          {Object.keys(selectedOAuth2Preset.scopes).length === 0 ? (
                            <div className="text-sm italic text-muted-foreground">
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
                                  <div className="font-mono text-sm text-foreground">{scope}</div>
                                  {description && (
                                    <div className="text-xs text-muted-foreground">
                                      {description}
                                    </div>
                                  )}
                                </div>
                              </Label>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  )
                }
                headers={headers}
                onHeadersChange={setHeaders}
                secrets={secretList}
              />
            </div>
          )}

          {activeTab === "operations" && (
            <SourceOperations operations={operationEntries} />
          )}
        </>
      )}

      {/* Post-probe error */}
      {error && probeResult && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{error}</p>
        </div>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        {probeResult && (
          <Button onClick={handleAdd} disabled={!canAdd || adding}>
            {adding && <Spinner className="size-3.5" />}
            {adding ? "Adding…" : "Add source"}
          </Button>
        )}
      </FloatActions>
    </div>
  );
}

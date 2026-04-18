import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useAtomSet, useAtomRefresh, Result } from "@effect-atom/atom-react";
import { Option } from "effect";

import { openOAuthPopup, type OAuthPopupResult } from "@executor/plugin-oauth2/react";

import {
  openApiSourceAtom,
  probeOpenApiSpec,
  startOpenApiOAuth,
  updateOpenApiSource,
} from "./atoms";
import { useScope } from "@executor/react/api/scope-context";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import {
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import { SourceConfig, type AuthMode, type OAuthStatus } from "@executor/react/plugins/source-config";
import { newKeyValueEntry, type KeyValueEntry } from "@executor/react/plugins/key-value-list";
import { Button } from "@executor/react/components/button";
import { FloatActions } from "@executor/react/components/float-actions";
import type { StoredSourceSchemaType } from "../sdk/stored-source";
import { supportedAuthModesFromSchemes, type OAuth2Preset, type SpecPreview } from "../sdk/preview";
import { OAuth2Auth, type HeaderValue } from "../sdk/types";

const OPENAPI_OAUTH_CHANNEL = "executor:openapi-oauth-result";
const OPENAPI_OAUTH_POPUP_NAME = "openapi-oauth";

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

function detectAuth(
  allHeaders: Readonly<Record<string, HeaderValue>>,
  hasOAuth: boolean,
): {
  mode: AuthMode;
  bearerSecretId: string | null;
  otherHeaders: KeyValueEntry[];
} {
  if (hasOAuth) {
    return { mode: "oauth", bearerSecretId: null, otherHeaders: toEntries(allHeaders) };
  }
  const authHeader = allHeaders["Authorization"];
  if (
    authHeader &&
    typeof authHeader !== "string" &&
    authHeader.prefix === "Bearer "
  ) {
    const rest = { ...allHeaders };
    delete rest["Authorization"];
    return {
      mode: "bearer",
      bearerSecretId: authHeader.secretId,
      otherHeaders: toEntries(rest),
    };
  }
  return { mode: "none", bearerSecretId: null, otherHeaders: toEntries(allHeaders) };
}

function toEntries(headers: Readonly<Record<string, HeaderValue>>): KeyValueEntry[] {
  return Object.entries(headers).map(([name, value]) => {
    if (typeof value === "string") {
      return newKeyValueEntry({ key: name, value, type: "text" });
    }
    return newKeyValueEntry({ key: name, value: value.secretId, type: "secret" });
  });
}

function EditForm(props: {
  sourceId: string;
  initial: StoredSourceSchemaType;
  onSave: () => void;
}) {
  const scopeId = useScope();
  const doUpdate = useAtomSet(updateOpenApiSource, { mode: "promise" });
  const doProbe = useAtomSet(probeOpenApiSpec, { mode: "promise" });
  const doStartOAuth = useAtomSet(startOpenApiOAuth, { mode: "promise" });
  const refreshSource = useAtomRefresh(openApiSourceAtom(scopeId, props.sourceId));
  const secretList = useSecretPickerSecrets();

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [baseUrl, setBaseUrl] = useState(props.initial.config.baseUrl ?? "");

  const initialOAuth =
    props.initial.config.oauth2 ??
    (props.initial.invocationConfig && Option.isSome(props.initial.invocationConfig.oauth2)
      ? props.initial.invocationConfig.oauth2.value
      : null);
  const initialAuth = detectAuth(
    props.initial.config.headers ?? {},
    Boolean(initialOAuth),
  );
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuth.mode);
  const [bearerSecretId, setBearerSecretId] = useState<string | null>(
    initialAuth.bearerSecretId,
  );
  const [headers, setHeaders] = useState<readonly KeyValueEntry[]>(initialAuth.otherHeaders);

  // OAuth state — starts from what was persisted, and gets re-issued if the
  // user signs out + signs in again.
  const [oauth2Auth, setOauth2Auth] = useState<OAuth2Auth | null>(initialOAuth);
  const [oauth2Dirty, setOauth2Dirty] = useState(false);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [oauth2Error, setOauth2Error] = useState<string | null>(null);
  const [oauth2Preset, setOauth2Preset] = useState<OAuth2Preset | null>(null);
  const [probeResult, setProbeResult] = useState<SpecPreview | null>(null);
  const oauthCleanup = useRef<(() => void) | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const identityDirty = identity.name.trim() !== props.initial.name.trim();

  const oauthStatus: OAuthStatus = oauth2Auth
    ? { step: "authenticated" }
    : startingOAuth
      ? { step: "waiting" }
      : oauth2Error
        ? { step: "error", message: oauth2Error }
        : { step: "idle" };

  // Re-probe the spec to know which auth modes the spec supports, and —
  // for OAuth sources — to recover the authorization URL (not persisted on
  // OAuth2Auth) so we can restart the flow.
  useEffect(() => {
    let cancelled = false;
    doProbe({
      path: { scopeId },
      payload: { spec: props.initial.config.spec },
    })
      .then((result) => {
        if (cancelled) return;
        setProbeResult(result);
        if (initialOAuth) {
          const preset = result.oauth2Presets.find(
            (p) => p.securitySchemeName === initialOAuth.securitySchemeName,
          );
          setOauth2Preset(preset ?? null);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialOAuth, props.initial.config.spec, doProbe, scopeId]);

  const disabledAuthModes = useMemo<readonly AuthMode[]>(() => {
    if (!probeResult) return [];
    const supported = supportedAuthModesFromSchemes(probeResult.securitySchemes);
    return (["basic", "apikey", "bearer", "oauth"] as const).filter(
      (m) => !supported.has(m),
    );
  }, [probeResult]);

  useEffect(() => () => oauthCleanup.current?.(), []);

  const handleHeadersChange = (next: readonly KeyValueEntry[]) => {
    setHeaders(next);
    setDirty(true);
  };

  const handleAuthModeChange = (mode: AuthMode) => {
    setAuthMode(mode);
    setDirty(true);
  };

  const handleBearerSecretChange = (secretId: string) => {
    setBearerSecretId(secretId);
    setDirty(true);
  };

  const handleSignOut = useCallback(() => {
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    setOauth2Auth(null);
    setOauth2Error(null);
    setStartingOAuth(false);
    setOauth2Dirty(true);
    setDirty(true);
  }, []);

  const handleStartOAuth = useCallback(async () => {
    if (!initialOAuth) return;
    if (!oauth2Preset || Option.isNone(oauth2Preset.authorizationUrl)) {
      setOauth2Error(
        "Authorization URL for this source could not be resolved — the spec may have changed.",
      );
      return;
    }
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    setStartingOAuth(true);
    setOauth2Error(null);
    try {
      const displayName = identity.name.trim() || initialOAuth.securitySchemeName;

      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          displayName,
          securitySchemeName: initialOAuth.securitySchemeName,
          flow: "authorizationCode",
          authorizationUrl: oauth2Preset.authorizationUrl.value,
          tokenUrl: initialOAuth.tokenUrl,
          redirectUrl: `${window.location.origin}/api/openapi/oauth/callback`,
          clientIdSecretId: initialOAuth.clientIdSecretId,
          clientSecretSecretId: initialOAuth.clientSecretSecretId,
          scopes: [...initialOAuth.scopes],
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
            setOauth2Dirty(true);
            setDirty(true);
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
  }, [initialOAuth, oauth2Preset, doStartOAuth, scopeId, identity.name]);

  const handleCancelOAuth2 = useCallback(() => {
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    setStartingOAuth(false);
    setOauth2Error(null);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const headersPayload: Record<string, { secretId: string; prefix?: string }> = {};
      if (authMode === "bearer" && bearerSecretId) {
        headersPayload["Authorization"] = { secretId: bearerSecretId, prefix: "Bearer " };
      }
      for (const entry of headers) {
        const name = entry.key.trim();
        if (!name || !entry.value) continue;
        if (entry.type === "secret") {
          headersPayload[name] = { secretId: entry.value };
        }
      }

      await doUpdate({
        path: { scopeId, namespace: props.sourceId },
        payload: {
          name: identity.name.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          headers: headersPayload,
          ...(oauth2Dirty ? { oauth2: oauth2Auth } : {}),
        },
      });
      refreshSource();
      setDirty(false);
      setOauth2Dirty(false);
      props.onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update source");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <SourceIdentityFields
        identity={identity}
        namespaceReadOnly
        endpoint={baseUrl}
        onEndpointChange={(v) => { setBaseUrl(v); setDirty(true); }}
        endpointLabel="URL"
      />

      <SourceConfig
        authMode={authMode}
        onAuthModeChange={handleAuthModeChange}
        disabledAuthModes={disabledAuthModes}
        bearerSecretId={bearerSecretId}
        onBearerSecretChange={handleBearerSecretChange}
        oauthStatus={oauthStatus}
        onOAuthSignIn={initialOAuth ? handleStartOAuth : undefined}
        onOAuthCancel={handleCancelOAuth2}
        onOAuthSignOut={oauth2Auth ? handleSignOut : undefined}
        headers={headers}
        onHeadersChange={handleHeadersChange}
        secrets={secretList}
      />

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <FloatActions>
        <Button onClick={handleSave} disabled={(!dirty && !identityDirty) || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </FloatActions>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EditOpenApiSource(props: { sourceId: string; onSave: () => void }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(openApiSourceAtom(scopeId, props.sourceId));

  if (!Result.isSuccess(sourceResult) || !sourceResult.value) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      </div>
    );
  }

  return <EditForm sourceId={props.sourceId} initial={sourceResult.value} onSave={props.onSave} />;
}

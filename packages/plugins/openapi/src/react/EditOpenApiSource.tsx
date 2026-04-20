import { useCallback, useEffect, useRef, useState } from "react";
import {
  useAtomValue,
  useAtomSet,
  useAtomRefresh,
  Result,
} from "@effect-atom/atom-react";
import { Option } from "effect";

import { SecretId } from "@executor/sdk";
import { openOAuthPopup, type OAuthPopupResult } from "@executor/plugin-oauth2/react";

import {
  openApiSourceAtom,
  previewOpenApiSpec,
  startOpenApiOAuth,
  updateOpenApiSource,
} from "./atoms";
import { useScope } from "@executor/react/api/scope-context";
import {
  secretStatusAtom,
  removeSecret,
} from "@executor/react/api/atoms";
import {
  secretWriteKeys,
  sourceWriteKeys,
} from "@executor/react/api/reactivity-keys";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import {
  headerValueToState,
  headersFromState,
  type HeaderState,
} from "@executor/react/plugins/secret-header-auth";
import { HeadersList } from "@executor/react/plugins/headers-list";
import {
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { FieldLabel } from "@executor/react/components/field";
import { Input } from "@executor/react/components/input";
import { Badge } from "@executor/react/components/badge";
import { Spinner } from "@executor/react/components/spinner";
import {
  OPENAPI_OAUTH_CALLBACK_PATH,
  OPENAPI_OAUTH_CHANNEL,
  OPENAPI_OAUTH_POPUP_NAME,
} from "./AddOpenApiSource";
import type { SpecPreview, OAuth2Preset } from "../sdk/preview";
import { OAuth2Auth } from "../sdk/types";
import type { StoredSourceSchemaType } from "../sdk/store";

// ---------------------------------------------------------------------------
// Connections — one row per OAuth2Auth on the source
// ---------------------------------------------------------------------------

/**
 * Single OAuth2Auth connection row. Each org member sees the status of
 * their own tokens (access/refresh secrets resolve via per-user scope
 * fall-through) and can trigger the same OAuth flow another member used
 * when first onboarding the source.
 */
function ConnectionRow(props: {
  readonly auth: OAuth2Auth;
  readonly sourceName: string;
  readonly preset: OAuth2Preset | null;
  readonly previewError: string | null;
}) {
  const scopeId = useScope();
  const { auth, preset } = props;

  const statusAtom = secretStatusAtom(
    scopeId,
    SecretId.make(auth.accessTokenSecretId),
  );
  const accessStatus = useAtomValue(statusAtom);
  const refreshStatus = useAtomRefresh(statusAtom);
  const isConnected =
    Result.isSuccess(accessStatus) && accessStatus.value.status === "resolved";

  const doStartOAuth = useAtomSet(startOpenApiOAuth, { mode: "promise" });
  const doRemoveSecret = useAtomSet(removeSecret, { mode: "promise" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const redirectUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${OPENAPI_OAUTH_CALLBACK_PATH}`
      : OPENAPI_OAUTH_CALLBACK_PATH;

  const handleConnect = useCallback(async () => {
    if (!preset) return;
    cleanupRef.current?.();
    cleanupRef.current = null;
    setBusy(true);
    setError(null);
    try {
      if (auth.flow === "clientCredentials") {
        // No popup, no session — the backend exchanges tokens inline.
        if (!auth.clientSecretSecretId) {
          setBusy(false);
          setError("client_credentials requires a client secret");
          return;
        }
        const response = await doStartOAuth({
          path: { scopeId },
          payload: {
            displayName: props.sourceName || auth.securitySchemeName,
            securitySchemeName: auth.securitySchemeName,
            flow: "clientCredentials",
            tokenUrl: auth.tokenUrl,
            clientIdSecretId: auth.clientIdSecretId,
            clientSecretSecretId: auth.clientSecretSecretId,
            scopes: [...auth.scopes],
            accessTokenSecretId: auth.accessTokenSecretId,
          },
        });
        setBusy(false);
        if (response.flow !== "clientCredentials") {
          setError("Unexpected response flow from server");
          return;
        }
        setError(null);
        refreshStatus();
        return;
      }

      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          displayName: props.sourceName || auth.securitySchemeName,
          securitySchemeName: auth.securitySchemeName,
          flow: "authorizationCode",
          authorizationUrl: Option.getOrElse(preset.authorizationUrl, () => ""),
          tokenUrl: auth.tokenUrl,
          redirectUrl,
          clientIdSecretId: auth.clientIdSecretId,
          clientSecretSecretId: auth.clientSecretSecretId,
          // Reuse the source-wide scopes granted at onboarding time —
          // per-member connects should land the same capabilities.
          scopes: [...auth.scopes],
          // Reuse the same secret ids the source already references.
          // On completeOAuth the plugin writes tokens at the innermost
          // (per-user) scope by default; same id + inner scope shadows
          // any org-level fallback so each member's bearer is theirs.
          accessTokenSecretId: auth.accessTokenSecretId,
          refreshTokenSecretId: auth.refreshTokenSecretId,
        },
      });

      if (response.flow !== "authorizationCode") {
        setBusy(false);
        setError("Unexpected response flow from server");
        return;
      }

      cleanupRef.current = openOAuthPopup<OAuth2Auth>({
        url: response.authorizationUrl,
        popupName: OPENAPI_OAUTH_POPUP_NAME,
        channelName: OPENAPI_OAUTH_CHANNEL,
        onResult: (result: OAuthPopupResult<OAuth2Auth>) => {
          cleanupRef.current = null;
          setBusy(false);
          if (result.ok) {
            setError(null);
            // completeOAuth ran server-side (inside the popup's callback
            // HTML handler) and wrote the access/refresh tokens via
            // ctx.secrets.set — that bypasses our atom-layer mutation,
            // so we refresh the status atom here to flip the badge.
            refreshStatus();
          } else {
            setError(result.error);
          }
        },
        onClosed: () => {
          cleanupRef.current = null;
          setBusy(false);
          setError("OAuth cancelled — popup was closed before completing the flow.");
        },
        onOpenFailed: () => {
          cleanupRef.current = null;
          setBusy(false);
          setError("OAuth popup was blocked by the browser");
        },
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Failed to start OAuth");
    }
  }, [
    preset,
    auth.flow,
    auth.securitySchemeName,
    auth.tokenUrl,
    auth.clientIdSecretId,
    auth.clientSecretSecretId,
    auth.accessTokenSecretId,
    auth.refreshTokenSecretId,
    auth.scopes,
    doStartOAuth,
    redirectUrl,
    scopeId,
    props.sourceName,
    refreshStatus,
  ]);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await doRemoveSecret({
        path: {
          scopeId,
          secretId: SecretId.make(auth.accessTokenSecretId),
        },
        reactivityKeys: secretWriteKeys,
      });
      if (auth.refreshTokenSecretId) {
        await doRemoveSecret({
          path: {
            scopeId,
            secretId: SecretId.make(auth.refreshTokenSecretId),
          },
          reactivityKeys: secretWriteKeys,
        }).catch(() => {
          // The refresh secret may not exist for this user — ignore.
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setBusy(false);
    }
  }, [
    doRemoveSecret,
    scopeId,
    auth.accessTokenSecretId,
    auth.refreshTokenSecretId,
  ]);

  const canConnect = preset !== null && Option.isSome(preset.authorizationUrl);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">
            {auth.securitySchemeName}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {auth.scopes.length} scope{auth.scopes.length === 1 ? "" : "s"}
          </div>
        </div>
        {isConnected ? (
          <Badge
            variant="outline"
            className="border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400"
          >
            Connected
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            Not connected
          </Badge>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        {isConnected ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDisconnect}
            disabled={busy}
          >
            {busy && <Spinner className="size-3.5" />}
            Disconnect
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={handleConnect}
            disabled={busy || !canConnect}
          >
            {busy && <Spinner className="size-3.5" />}
            Connect
          </Button>
        )}
      </div>

      {!canConnect && props.previewError && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {props.previewError}
        </p>
      )}
      {!canConnect && !props.previewError && preset === null && (
        <p className="text-[11px] text-muted-foreground">
          Loading OAuth configuration…
        </p>
      )}
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5">
          <p className="text-[11px] text-destructive">{error}</p>
        </div>
      )}
    </div>
  );
}

function ConnectionsSection(props: {
  readonly sourceName: string;
  readonly spec: string;
  readonly oauth2Entries: readonly OAuth2Auth[];
}) {
  const scopeId = useScope();
  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promise" });
  const [preview, setPreview] = useState<SpecPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    doPreview({ path: { scopeId }, payload: { spec: props.spec } })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setPreviewError(
            e instanceof Error
              ? `Couldn't load OAuth config from spec: ${e.message}`
              : "Couldn't load OAuth config from spec",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [doPreview, scopeId, props.spec]);

  const presetFor = (securitySchemeName: string): OAuth2Preset | null => {
    if (!preview) return null;
    return (
      preview.oauth2Presets.find(
        (p) =>
          p.securitySchemeName === securitySchemeName &&
          p.flow === "authorizationCode",
      ) ?? null
    );
  };

  return (
    <section className="space-y-2.5">
      <div>
        <FieldLabel>Connections</FieldLabel>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Each member of this organization connects with their own OAuth
          credentials.
        </p>
      </div>
      <div className="space-y-2">
        {props.oauth2Entries.map((auth) => (
          <ConnectionRow
            key={auth.securitySchemeName}
            auth={auth}
            sourceName={props.sourceName}
            preset={presetFor(auth.securitySchemeName)}
            previewError={previewError}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

function EditForm(props: {
  sourceId: string;
  initial: StoredSourceSchemaType;
  onSave: () => void;
}) {
  const scopeId = useScope();
  const doUpdate = useAtomSet(updateOpenApiSource, { mode: "promise" });
  const secretList = useSecretPickerSecrets();

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [baseUrl, setBaseUrl] = useState(props.initial.config.baseUrl ?? "");
  const [headers, setHeaders] = useState<HeaderState[]>(() =>
    Object.entries(props.initial.config.headers ?? {}).map(([name, value]) =>
      headerValueToState(name, value),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const identityDirty = identity.name.trim() !== props.initial.name.trim();

  // A source may have zero or one stored OAuth2Auth today, but the
  // "Connections" section is written to iterate so future multi-scheme
  // specs surface without another pass.
  const oauth2Entries: readonly OAuth2Auth[] = props.initial.config.oauth2
    ? [props.initial.config.oauth2]
    : [];

  const handleHeadersChange = (next: HeaderState[]) => {
    setHeaders(next);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await doUpdate({
        path: { scopeId, namespace: props.sourceId },
        payload: {
          name: identity.name.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          headers: headersFromState(headers),
        },
        reactivityKeys: sourceWriteKeys,
      });
      setDirty(false);
      props.onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update source");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit OpenAPI Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the base URL and authentication headers for this source.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-xs">
          OpenAPI
        </Badge>
      </div>

      <SourceIdentityFields identity={identity} namespaceReadOnly />

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Base URL">
            <Input
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl((e.target as HTMLInputElement).value);
                setDirty(true);
              }}
              placeholder="https://api.example.com"
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <section className="space-y-2.5">
        <FieldLabel>Headers</FieldLabel>
        <HeadersList
          headers={headers}
          onHeadersChange={handleHeadersChange}
          existingSecrets={secretList}
          sourceName={identity.name}
        />
      </section>

      {oauth2Entries.length > 0 && (
        <ConnectionsSection
          sourceName={props.initial.name}
          spec={props.initial.config.spec}
          oauth2Entries={oauth2Entries}
        />
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={(!dirty && !identityDirty) || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
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
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit OpenAPI Source</h1>
          <p className="mt-1 text-sm text-muted-foreground">Loading configuration…</p>
        </div>
      </div>
    );
  }

  return <EditForm sourceId={props.sourceId} initial={sourceResult.value} onSave={props.onSave} />;
}

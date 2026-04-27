import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";

import {
  cancelOAuth,
  connectionsAtom,
  startOAuth,
} from "@executor/react/api/atoms";
import {
  openOAuthPopup,
  type OAuthPopupResult,
} from "@executor/react/api/oauth-popup";
import { useScope } from "@executor/react/api/scope-context";
import {
  connectionWriteKeys,
  sourceWriteKeys,
} from "@executor/react/api/reactivity-keys";
import { OAUTH_POPUP_MESSAGE_TYPE } from "@executor/sdk";
import { Button } from "@executor/react/components/button";

import {
  googleDiscoverySourceAtom,
  updateGoogleDiscoverySource,
} from "./atoms";

// ---------------------------------------------------------------------------
// GoogleDiscoverySignInButton — top-bar action on the source detail page.
//
// Drives the shared /scopes/:scopeId/oauth/{start,callback} surface with
// a Google-specific `authorization-code` strategy. On success rewrites
// the source's auth pointer to the freshly minted connection id. Works
// whether or not the previous Connection still exists — source-owned
// OAuth config is the source of truth.
// ---------------------------------------------------------------------------

const GOOGLE_AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GOOGLE_EXTRA_AUTHORIZATION_PARAMS = {
  access_type: "offline",
  include_granted_scopes: "true",
  prompt: "consent",
} as const;

const OAUTH_CALLBACK_PATH = "/api/oauth/callback";
const POPUP_NAME = "google-discovery-oauth";
const signInWriteKeys = [
  ...sourceWriteKeys,
  ...connectionWriteKeys,
] as const;

type CompletionPayload = {
  connectionId: string;
  expiresAt: number | null;
  scope: string | null;
};

export default function GoogleDiscoverySignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(googleDiscoverySourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promise" });
  const doCancelOAuth = useAtomSet(cancelOAuth, { mode: "promise" });
  const doUpdate = useAtomSet(updateGoogleDiscoverySource, { mode: "promise" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const source =
    Result.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const auth = source?.config.auth;
  const oauth2 = auth && auth.kind === "oauth2" ? auth : null;
  const connections = Result.isSuccess(connectionsResult)
    ? connectionsResult.value
    : null;
  const isConnected =
    oauth2 !== null &&
    connections !== null &&
    connections.some((c) => c.id === oauth2.connectionId);

  const redirectUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${OAUTH_CALLBACK_PATH}`
      : OAUTH_CALLBACK_PATH;

  const handleSignIn = useCallback(async () => {
    if (!oauth2 || !source) return;
    cleanupRef.current?.();
    cleanupRef.current = null;
    setBusy(true);
    setError(null);
    try {
      const connectionId = oauth2.connectionId;
      const scopes = [...oauth2.scopes];
      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          endpoint: source.config.discoveryUrl,
          redirectUrl,
          connectionId,
          identityLabel: `${source.name.trim() || props.sourceId} OAuth`,
          strategy: {
            kind: "authorization-code",
            authorizationEndpoint: GOOGLE_AUTHORIZATION_URL,
            tokenEndpoint: GOOGLE_TOKEN_URL,
            issuerUrl: "https://accounts.google.com",
            clientIdSecretId: oauth2.clientIdSecretId,
            clientSecretSecretId: oauth2.clientSecretSecretId,
            scopes,
            extraAuthorizationParams: GOOGLE_EXTRA_AUTHORIZATION_PARAMS,
          },
          pluginId: "google-discovery",
        },
      });

      if (response.authorizationUrl === null) {
        setBusy(false);
        setError("OAuth start did not produce an authorization URL");
        return;
      }

      cleanupRef.current = openOAuthPopup<CompletionPayload>({
        url: response.authorizationUrl,
        popupName: POPUP_NAME,
        channelName: OAUTH_POPUP_MESSAGE_TYPE,
        expectedSessionId: response.sessionId,
        onResult: async (result: OAuthPopupResult<CompletionPayload>) => {
          cleanupRef.current = null;
          if (!result.ok) {
            setBusy(false);
            setError(result.error);
            return;
          }
          try {
            await doUpdate({
              path: { scopeId, namespace: props.sourceId },
              payload: {
                auth: {
                  kind: "oauth2",
                  connectionId: result.connectionId,
                  clientIdSecretId: oauth2.clientIdSecretId,
                  clientSecretSecretId: oauth2.clientSecretSecretId,
                  scopes,
                },
              },
              reactivityKeys: signInWriteKeys,
            });
            setBusy(false);
          } catch (e) {
            setBusy(false);
            setError(
              e instanceof Error ? e.message : "Failed to persist new connection",
            );
          }
        },
        onClosed: () => {
          cleanupRef.current = null;
          void doCancelOAuth({
            path: { scopeId },
            payload: { sessionId: response.sessionId },
          }).catch(() => undefined);
          setBusy(false);
          setError("Sign-in cancelled — popup was closed before completing the flow.");
        },
        onOpenFailed: () => {
          cleanupRef.current = null;
          void doCancelOAuth({
            path: { scopeId },
            payload: { sessionId: response.sessionId },
          }).catch(() => undefined);
          setBusy(false);
          setError("Sign-in popup was blocked by the browser");
        },
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Failed to start sign-in");
    }
  }, [oauth2, source, scopeId, props.sourceId, redirectUrl, doStartOAuth, doCancelOAuth, doUpdate]);

  if (!oauth2) return null;

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleSignIn()}
        disabled={busy}
      >
        {busy
          ? isConnected
            ? "Reconnecting…"
            : "Signing in…"
          : isConnected
            ? "Reconnect"
            : "Sign in"}
      </Button>
    </div>
  );
}

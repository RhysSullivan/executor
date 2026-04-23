import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";

import { openOAuthPopup, type OAuthPopupResult } from "@executor/plugin-oauth2/react";
import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { connectionsAtom } from "@executor/react/api/atoms";
import { Button } from "@executor/react/components/button";

import {
  googleDiscoverySourceAtom,
  startGoogleDiscoveryOAuth,
  updateGoogleDiscoverySource,
} from "./atoms";

// ---------------------------------------------------------------------------
// GoogleDiscoverySignInButton — top-bar action on the source detail page.
//
// Reads the source's stored `GoogleDiscoveryAuth`, re-runs the authorization
// code flow via popup using the same `clientIdSecretId` / `clientSecretSecretId`
// / `scopes` the source was originally configured with, and on success
// rewrites the source's auth pointer to the freshly minted connection id.
// Works whether or not the previous Connection still exists — source-owned
// OAuth config is the source of truth.
// ---------------------------------------------------------------------------

const CALLBACK_PATH = "/api/google-discovery/oauth/callback";
const POPUP_NAME = "google-discovery-oauth";
const CHANNEL_NAME = "executor:google-discovery-oauth-result";

type GoogleOAuthPopupPayload = {
  kind: "oauth2";
  connectionId: string;
  clientIdSecretId: string;
  clientSecretSecretId: string | null;
  scopes: readonly string[];
};

export default function GoogleDiscoverySignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(googleDiscoverySourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doStartOAuth = useAtomSet(startGoogleDiscoveryOAuth, { mode: "promise" });
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
      ? `${window.location.origin}${CALLBACK_PATH}`
      : CALLBACK_PATH;

  const handleSignIn = useCallback(async () => {
    if (!oauth2 || !source) return;
    cleanupRef.current?.();
    cleanupRef.current = null;
    setBusy(true);
    setError(null);
    try {
      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          name: source.name,
          discoveryUrl: source.config.discoveryUrl,
          clientIdSecretId: oauth2.clientIdSecretId,
          clientSecretSecretId: oauth2.clientSecretSecretId,
          redirectUrl,
          scopes: [...oauth2.scopes],
        },
      });

      cleanupRef.current = openOAuthPopup<GoogleOAuthPopupPayload>({
        url: response.authorizationUrl,
        popupName: POPUP_NAME,
        channelName: CHANNEL_NAME,
        onResult: async (result: OAuthPopupResult<GoogleOAuthPopupPayload>) => {
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
                  clientIdSecretId: result.clientIdSecretId,
                  clientSecretSecretId: result.clientSecretSecretId,
                  scopes: result.scopes,
                },
              },
              reactivityKeys: sourceWriteKeys,
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
          setBusy(false);
          setError("Sign-in cancelled — popup was closed before completing the flow.");
        },
        onOpenFailed: () => {
          cleanupRef.current = null;
          setBusy(false);
          setError("Sign-in popup was blocked by the browser");
        },
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Failed to start sign-in");
    }
  }, [oauth2, source, scopeId, props.sourceId, redirectUrl, doStartOAuth, doUpdate]);

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

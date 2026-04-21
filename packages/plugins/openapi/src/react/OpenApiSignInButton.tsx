import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";

import { openOAuthPopup, type OAuthPopupResult } from "@executor/plugin-oauth2/react";
import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { connectionsAtom } from "@executor/react/api/atoms";
import { Button } from "@executor/react/components/button";

import {
  openApiSourceAtom,
  startOpenApiOAuth,
  updateOpenApiSource,
} from "./atoms";
import {
  OPENAPI_OAUTH_CALLBACK_PATH,
  OPENAPI_OAUTH_CHANNEL,
  OPENAPI_OAUTH_POPUP_NAME,
} from "./AddOpenApiSource";
import { OAuth2Auth } from "../sdk/types";

// ---------------------------------------------------------------------------
// OpenApiSignInButton — top-bar action on the source detail page
//
// Reads the source's stored OAuth2Auth, runs the same OAuth flow as Add
// (authorizationCode via popup, clientCredentials inline), and on success
// rewrites the source's OAuth2Auth pointer to the freshly minted
// connection id. Works whether or not the previous connection still
// exists — source-owned OAuth config is the source of truth.
// ---------------------------------------------------------------------------

export default function OpenApiSignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(openApiSourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doStartOAuth = useAtomSet(startOpenApiOAuth, { mode: "promise" });
  const doUpdate = useAtomSet(updateOpenApiSource, { mode: "promise" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const source =
    Result.isSuccess(sourceResult) && sourceResult.value
      ? sourceResult.value
      : null;
  const oauth2 = source?.config.oauth2 ?? null;
  const connections = Result.isSuccess(connectionsResult)
    ? connectionsResult.value
    : null;
  const isConnected =
    oauth2 !== null &&
    connections !== null &&
    connections.some((c) => c.id === oauth2.connectionId);

  const redirectUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${OPENAPI_OAUTH_CALLBACK_PATH}`
      : OPENAPI_OAUTH_CALLBACK_PATH;

  const handleSignIn = useCallback(async () => {
    if (!oauth2) return;
    cleanupRef.current?.();
    cleanupRef.current = null;
    setBusy(true);
    setError(null);
    try {
      const displayName = source?.name ?? oauth2.securitySchemeName;

      if (oauth2.flow === "clientCredentials") {
        if (!oauth2.clientSecretSecretId) {
          setBusy(false);
          setError("client_credentials requires a client secret");
          return;
        }
        const response = await doStartOAuth({
          path: { scopeId },
          payload: {
            displayName,
            securitySchemeName: oauth2.securitySchemeName,
            flow: "clientCredentials",
            tokenUrl: oauth2.tokenUrl,
            clientIdSecretId: oauth2.clientIdSecretId,
            clientSecretSecretId: oauth2.clientSecretSecretId,
            scopes: [...oauth2.scopes],
          },
        });
        if (response.flow !== "clientCredentials") {
          setBusy(false);
          setError("Unexpected response flow from server");
          return;
        }
        await doUpdate({
          path: { scopeId, namespace: props.sourceId },
          payload: { oauth2: response.auth },
          reactivityKeys: sourceWriteKeys,
        });
        setBusy(false);
        return;
      }

      if (!oauth2.authorizationUrl) {
        setBusy(false);
        setError("authorizationCode flow is missing its authorization URL");
        return;
      }

      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          displayName,
          securitySchemeName: oauth2.securitySchemeName,
          flow: "authorizationCode",
          authorizationUrl: oauth2.authorizationUrl,
          tokenUrl: oauth2.tokenUrl,
          redirectUrl,
          clientIdSecretId: oauth2.clientIdSecretId,
          clientSecretSecretId: oauth2.clientSecretSecretId ?? undefined,
          scopes: [...oauth2.scopes],
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
        onResult: async (result: OAuthPopupResult<OAuth2Auth>) => {
          cleanupRef.current = null;
          if (!result.ok) {
            setBusy(false);
            setError(result.error);
            return;
          }
          try {
            const nextAuth = new OAuth2Auth({
              kind: "oauth2",
              connectionId: result.connectionId,
              securitySchemeName: result.securitySchemeName,
              flow: result.flow,
              tokenUrl: result.tokenUrl,
              authorizationUrl: result.authorizationUrl,
              clientIdSecretId: result.clientIdSecretId,
              clientSecretSecretId: result.clientSecretSecretId,
              scopes: result.scopes,
            });
            await doUpdate({
              path: { scopeId, namespace: props.sourceId },
              payload: { oauth2: nextAuth },
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
  }, [
    oauth2,
    source?.name,
    scopeId,
    props.sourceId,
    redirectUrl,
    doStartOAuth,
    doUpdate,
  ]);

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

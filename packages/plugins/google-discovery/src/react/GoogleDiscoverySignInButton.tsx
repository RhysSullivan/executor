import { useCallback } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";

import { connectionsAtom } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { connectionWriteKeys, sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { Button } from "@executor/react/components/button";
import {
  oauthCallbackUrl,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor/react/plugins/oauth-sign-in";

import { googleDiscoverySourceAtom, updateGoogleDiscoverySource } from "./atoms";

// ---------------------------------------------------------------------------
// GoogleDiscoverySignInButton — top-bar action on the source detail page.
//
// Drives the shared /scopes/:scopeId/oauth/{start,callback} surface with
// a Google-specific `authorization-code` strategy. On success rewrites
// the source's auth pointer to the freshly minted connection id. Works
// whether or not the previous Connection still exists — source-owned
// OAuth config is the source of truth.
// ---------------------------------------------------------------------------

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GOOGLE_EXTRA_AUTHORIZATION_PARAMS = {
  access_type: "offline",
  include_granted_scopes: "true",
  prompt: "consent",
} as const;

const signInWriteKeys = [...sourceWriteKeys, ...connectionWriteKeys] as const;

export default function GoogleDiscoverySignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(googleDiscoverySourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doUpdate = useAtomSet(updateGoogleDiscoverySource, { mode: "promise" });
  const oauth = useOAuthPopupFlow({
    popupName: "google-discovery-oauth",
    popupBlockedMessage: "OAuth popup was blocked",
    popupClosedMessage: "OAuth cancelled: popup was closed before completing the flow.",
  });

  const source = Result.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const auth = source?.config.auth;
  const oauth2 = auth && auth.kind === "oauth2" ? auth : null;
  const connections = Result.isSuccess(connectionsResult) ? connectionsResult.value : null;
  const isConnected =
    oauth2 !== null &&
    connections !== null &&
    connections.some((c) => c.id === oauth2.connectionId);

  const handleSignIn = useCallback(async () => {
    if (!oauth2 || !source) return;
    const scopes = [...oauth2.scopes];
    await oauth.start({
      payload: {
        endpoint: source.config.discoveryUrl,
        redirectUrl: oauthCallbackUrl(),
        connectionId: oauth2.connectionId,
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
      onSuccess: async (result: OAuthCompletionPayload) => {
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
      },
    });
  }, [oauth2, source, scopeId, props.sourceId, doUpdate, oauth]);

  if (!oauth2) return null;

  return (
    <div className="flex items-center gap-2">
      {oauth.error && <span className="text-xs text-destructive">{oauth.error}</span>}
      <Button variant="outline" size="sm" onClick={() => void handleSignIn()} disabled={oauth.busy}>
        {oauth.busy
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

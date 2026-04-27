import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { cancelOAuth, connectionsAtom, startOAuth } from "@executor/react/api/atoms";
import {
  openOAuthPopup,
  type OAuthPopupResult,
} from "@executor/react/api/oauth-popup";
import { OAUTH_POPUP_MESSAGE_TYPE } from "@executor/sdk";
import { Button } from "@executor/react/components/button";
import { slugifyNamespace } from "@executor/react/plugins/source-identity";

import { mcpSourceAtom, updateMcpSource } from "./atoms";

// ---------------------------------------------------------------------------
// McpSignInButton — top-bar action on the source detail page.
//
// Reads the source's stored endpoint + oauth2 pointer, re-runs the DCR /
// authorization-code flow against a stable `mcp-oauth2-${namespace}`
// connection id, and on success rewrites the source's auth pointer to
// the freshly minted connection. Works whether or not the previous
// Connection still exists — source-owned config is the source of truth.
// ---------------------------------------------------------------------------

const CALLBACK_PATH = "/api/oauth/callback";
const POPUP_NAME = "mcp-oauth";
const CHANNEL_NAME = OAUTH_POPUP_MESSAGE_TYPE;

type McpOAuthPopupPayload = {
  connectionId: string;
  expiresAt: number | null;
  scope: string | null;
};

const mcpOAuthConnectionId = (namespaceSlug: string): string =>
  `mcp-oauth2-${namespaceSlug || "default"}`;

export default function McpSignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(mcpSourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promise" });
  const doCancelOAuth = useAtomSet(cancelOAuth, { mode: "promise" });
  const doUpdate = useAtomSet(updateMcpSource, { mode: "promise" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const source =
    Result.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const remote = source && source.config.transport === "remote" ? source.config : null;
  const oauth2 = remote && remote.auth.kind === "oauth2" ? remote.auth : null;
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
    if (!remote || !oauth2 || !source) return;
    cleanupRef.current?.();
    cleanupRef.current = null;
    setBusy(true);
    setError(null);
    try {
      const namespaceSlug = slugifyNamespace(source.namespace) || "mcp";
      const connectionId = mcpOAuthConnectionId(namespaceSlug);
      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          endpoint: remote.endpoint,
          redirectUrl,
          connectionId,
          strategy: { kind: "dynamic-dcr" },
          pluginId: "mcp",
          identityLabel: `${source.name.trim() || source.namespace || "MCP"} OAuth`,
        },
      });
      if (response.authorizationUrl === null) {
        setBusy(false);
        setError("OAuth start did not produce an authorization URL");
        return;
      }

      cleanupRef.current = openOAuthPopup<McpOAuthPopupPayload>({
        url: response.authorizationUrl,
        popupName: POPUP_NAME,
        channelName: CHANNEL_NAME,
        expectedSessionId: response.sessionId,
        onResult: async (result: OAuthPopupResult<McpOAuthPopupPayload>) => {
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
                auth: { kind: "oauth2", connectionId: result.connectionId },
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
  }, [remote, oauth2, source, scopeId, props.sourceId, redirectUrl, doStartOAuth, doCancelOAuth, doUpdate]);

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

import { useCallback } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { connectionsAtom } from "@executor/react/api/atoms";
import { Button } from "@executor/react/components/button";
import {
  oauthCallbackUrl,
  oauthConnectionId,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor/react/plugins/oauth-sign-in";
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

export default function McpSignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(mcpSourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doUpdate = useAtomSet(updateMcpSource, { mode: "promise" });
  const oauth = useOAuthPopupFlow({
    popupName: "mcp-oauth",
  });

  const source = Result.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const remote = source && source.config.transport === "remote" ? source.config : null;
  const oauth2 = remote && remote.auth.kind === "oauth2" ? remote.auth : null;
  const connections = Result.isSuccess(connectionsResult) ? connectionsResult.value : null;
  const isConnected =
    oauth2 !== null &&
    connections !== null &&
    connections.some((c) => c.id === oauth2.connectionId);

  const handleSignIn = useCallback(async () => {
    if (!remote || !oauth2 || !source) return;
    const namespaceSlug = slugifyNamespace(source.namespace) || "mcp";
    await oauth.start({
      payload: {
        endpoint: remote.endpoint,
        ...(remote.headers ? { headers: remote.headers } : {}),
        ...(remote.queryParams ? { queryParams: remote.queryParams } : {}),
        redirectUrl: oauthCallbackUrl(),
        connectionId: oauthConnectionId({
          pluginId: "mcp",
          namespace: namespaceSlug,
        }),
        strategy: { kind: "dynamic-dcr" },
        pluginId: "mcp",
        identityLabel: `${source.name.trim() || source.namespace || "MCP"} OAuth`,
      },
      onSuccess: async (result: OAuthCompletionPayload) => {
        await doUpdate({
          path: { scopeId, namespace: props.sourceId },
          payload: {
            auth: { kind: "oauth2", connectionId: result.connectionId },
          },
          reactivityKeys: sourceWriteKeys,
        });
      },
    });
  }, [remote, oauth2, source, scopeId, props.sourceId, doUpdate, oauth]);

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

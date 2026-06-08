import { useCallback, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import {
  AuthTemplateSlug,
  IntegrationSlug,
  OAuthClientSlug,
  type Connection,
  type Owner,
} from "@executor-js/sdk/shared";
import { connectionsAllAtom } from "@executor-js/react/api/atoms";
import { connectionIdentifier } from "@executor-js/react/lib/connection-name";
import { OAuthSignInButton, useOAuthPopupFlow } from "@executor-js/react/plugins/oauth-sign-in";

import { mcpServerAtom } from "./atoms";

const OAUTH_TEMPLATE = AuthTemplateSlug.make("oauth2");

// ---------------------------------------------------------------------------
// McpSignInButton — top-bar action on the integration detail page (v2).
//
// Reads the integration's auth template; for an `oauth2` server it runs the
// OAuth flow to mint a connection. "Connected" is derived from whether ANY
// owner already has a connection for this integration (the global owner toggle
// is retired, so the check merges both owners). The NEW connection's owner is a
// real create-target — chosen EXPLICITLY via the `owner` prop (default Workspace
// `org` on an org-scoped host, Local `org` on a non-org host like local),
// never read from an ambient owner.
// ---------------------------------------------------------------------------

export default function McpSignInButton(props: { sourceId: string; owner?: Owner }) {
  const slug = IntegrationSlug.make(props.sourceId);
  const targetOwner: Owner = props.owner ?? "org";
  const serverResult = useAtomValue(mcpServerAtom(slug));
  const connectionsResult = useAtomValue(connectionsAllAtom);
  const oauth = useOAuthPopupFlow({
    popupName: "mcp-oauth",
    detectPopupClosed: false,
    startErrorMessage: "Failed to start OAuth",
  });
  const [justConnected, setJustConnected] = useState(false);

  const server = AsyncResult.isSuccess(serverResult) ? serverResult.value : null;
  const remote = server !== null && server.config.transport === "remote" ? server.config : null;
  const isOAuth = remote !== null && remote.auth.kind === "oauth2";
  const connections: readonly Connection[] = AsyncResult.isSuccess(connectionsResult)
    ? connectionsResult.value
    : [];
  const hasConnection = connections.some(
    (connection: Connection) => connection.integration === slug,
  );

  const handleSignIn = useCallback(() => {
    if (server === null) return;
    void oauth.start({
      payload: {
        client: OAuthClientSlug.make(String(slug)),
        // MCP registers its client (DCR) under the connection owner.
        clientOwner: targetOwner,
        owner: targetOwner,
        name: connectionIdentifier(`${slug} oauth`),
        integration: slug,
        template: OAUTH_TEMPLATE,
        identityLabel: `${server.description || String(slug)} OAuth`,
      },
      onSuccess: () => setJustConnected(true),
    });
  }, [server, targetOwner, oauth, slug]);

  if (!isOAuth) return null;

  return (
    <OAuthSignInButton
      busy={oauth.busy}
      error={oauth.error}
      isConnected={hasConnection || justConnected}
      onSignIn={handleSignIn}
      reconnectingLabel="Reconnecting…"
      signingInLabel="Signing in…"
    />
  );
}

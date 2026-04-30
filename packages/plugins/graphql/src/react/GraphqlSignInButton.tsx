import { useCallback } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";

import { connectionsAtom } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import {
  OAuthSignInButton,
  oauthCallbackUrl,
  oauthConnectionId,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor/react/plugins/oauth-sign-in";
import { slugifyNamespace } from "@executor/react/plugins/source-identity";

import { graphqlSourceAtom, updateGraphqlSource } from "./atoms";

export default function GraphqlSignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(graphqlSourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doUpdate = useAtomSet(updateGraphqlSource, { mode: "promise" });
  const oauth = useOAuthPopupFlow({
    popupName: "graphql-oauth",
  });

  const source = Result.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const oauth2 = source?.auth.kind === "oauth2" ? source.auth : null;
  const connections = Result.isSuccess(connectionsResult) ? connectionsResult.value : null;
  const isConnected =
    oauth2 !== null &&
    connections !== null &&
    connections.some((c) => c.id === oauth2.connectionId);

  const handleSignIn = useCallback(async () => {
    if (!source || !oauth2) return;
    const namespaceSlug = slugifyNamespace(source.namespace) || "graphql";
    await oauth.start({
      payload: {
        endpoint: source.endpoint,
        ...(Object.keys(source.headers).length > 0 ? { headers: source.headers } : {}),
        ...(Object.keys(source.queryParams).length > 0 ? { queryParams: source.queryParams } : {}),
        redirectUrl: oauthCallbackUrl(),
        connectionId: oauthConnectionId({
          pluginId: "graphql",
          namespace: namespaceSlug,
        }),
        strategy: { kind: "dynamic-dcr" },
        pluginId: "graphql",
        identityLabel: `${source.name.trim() || source.namespace || "GraphQL"} OAuth`,
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
  }, [source, oauth2, scopeId, props.sourceId, doUpdate, oauth]);

  if (!oauth2) return null;

  return (
    <OAuthSignInButton
      busy={oauth.busy}
      error={oauth.error}
      isConnected={isConnected}
      onSignIn={() => void handleSignIn()}
    />
  );
}

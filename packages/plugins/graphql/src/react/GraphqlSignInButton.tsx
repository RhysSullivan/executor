import { useCallback } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { connectionsAtom } from "@executor-js/react/api/atoms";
import { useScope } from "@executor-js/react/api/scope-context";
import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  OAuthSignInButton,
  oauthCallbackUrl,
  oauthConnectionId,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor-js/react/plugins/oauth-sign-in";
import { slugifyNamespace } from "@executor-js/react/plugins/source-identity";

import { graphqlSourceAtom, updateGraphqlSource } from "./atoms";
import type { HeaderValue } from "../sdk/types";

export default function GraphqlSignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(graphqlSourceAtom(scopeId, props.sourceId) as any) as any;
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doUpdate = useAtomSet(updateGraphqlSource as any, { mode: "promise" } as any) as any;
  const oauth = useOAuthPopupFlow({
    popupName: "graphql-oauth",
  });

  const source =
    AsyncResult.isSuccess(sourceResult as any) && sourceResult.value
      ? (sourceResult.value as {
          readonly namespace: string;
          readonly name: string;
          readonly endpoint: string;
          readonly headers: Record<string, HeaderValue>;
          readonly queryParams: Record<string, HeaderValue>;
          readonly auth:
            | { readonly kind: "none" }
            | { readonly kind: "oauth2"; readonly connectionId: string };
        })
      : null;
  const oauth2 = source?.auth.kind === "oauth2" ? source.auth : null;
  const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : null;
  const isConnected =
    oauth2 !== null &&
    connections !== null &&
    connections.some((c: { readonly id: string }) => c.id === oauth2.connectionId);

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
          params: { scopeId, namespace: props.sourceId },
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

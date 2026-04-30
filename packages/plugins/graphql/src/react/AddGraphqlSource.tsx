import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { cancelOAuth, startOAuth } from "@executor/react/api/atoms";
import {
  openOAuthPopup,
  type OAuthPopupResult,
} from "@executor/react/api/oauth-popup";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { usePendingSources } from "@executor/react/api/optimistic";
import { OAUTH_POPUP_MESSAGE_TYPE } from "@executor/sdk";
import {
  HttpCredentialsEditor,
  httpCredentialsValid,
  serializeHttpCredentials,
  type HttpCredentialsState,
} from "@executor/react/plugins/http-credentials";
import {
  displayNameFromUrl,
  slugifyNamespace,
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import { Button } from "@executor/react/components/button";
import { FilterTabs } from "@executor/react/components/filter-tabs";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { FloatActions } from "@executor/react/components/float-actions";
import { Input } from "@executor/react/components/input";
import { Spinner } from "@executor/react/components/spinner";
import { addGraphqlSource } from "./atoms";
import { initialGraphqlCredentials } from "./defaults";
import type { HeaderValue } from "../sdk/types";

type AuthMode = "none" | "oauth2";

type OAuthTokens = {
  connectionId: string;
  expiresAt: number | null;
  scope: string | null;
};

const graphqlOAuthConnectionId = (namespaceSlug: string): string =>
  `graphql-oauth2-${namespaceSlug || "default"}`;

export default function AddGraphqlSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
}) {
  const [endpoint, setEndpoint] = useState(props.initialUrl ?? "");
  const identity = useSourceIdentity({
    fallbackName: displayNameFromUrl(endpoint) ?? "",
  });
  const [credentials, setCredentials] = useState<HttpCredentialsState>(
    initialGraphqlCredentials,
  );
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("none");
  const [tokens, setTokens] = useState<OAuthTokens | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const oauthCleanup = useRef<(() => void) | null>(null);
  const oauthSessionId = useRef<string | null>(null);

  const scopeId = useScope();
  const doAdd = useAtomSet(addGraphqlSource, { mode: "promise" });
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promise" });
  const doCancelOAuth = useAtomSet(cancelOAuth, { mode: "promise" });
  const { beginAdd } = usePendingSources();
  const secretList = useSecretPickerSecrets();

  const canAdd =
    endpoint.trim().length > 0 &&
    httpCredentialsValid(credentials) &&
    (authMode === "none" || tokens !== null) &&
    !oauthBusy;

  const sourceIdentity = useCallback(() => {
    const trimmedEndpoint = endpoint.trim();
    const namespace =
      slugifyNamespace(identity.namespace) ||
      slugifyNamespace(displayNameFromUrl(trimmedEndpoint) ?? "") ||
      "graphql";
    const displayName =
      identity.name.trim() || displayNameFromUrl(trimmedEndpoint) || namespace;
    return { trimmedEndpoint, namespace, displayName };
  }, [endpoint, identity.name, identity.namespace]);

  const cancelActiveOAuth = useCallback(() => {
    const sessionId = oauthSessionId.current;
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    oauthSessionId.current = null;
    if (sessionId) {
      void doCancelOAuth({
        path: { scopeId },
        payload: { sessionId },
      }).catch(() => undefined);
    }
  }, [doCancelOAuth, scopeId]);

  useEffect(() => () => cancelActiveOAuth(), [cancelActiveOAuth]);

  const handleOAuth = useCallback(async () => {
    if (!endpoint.trim() || !httpCredentialsValid(credentials)) return;
    cancelActiveOAuth();
    setOauthBusy(true);
    setAddError(null);
    const { trimmedEndpoint, namespace, displayName } = sourceIdentity();
    const { headers, queryParams } = serializeHttpCredentials(credentials);
    try {
      const result = await doStartOAuth({
        path: { scopeId },
        payload: {
          endpoint: trimmedEndpoint,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
          redirectUrl: `${window.location.origin}/api/oauth/callback`,
          connectionId: graphqlOAuthConnectionId(namespace),
          strategy: { kind: "dynamic-dcr" },
          pluginId: "graphql",
          identityLabel: `${displayName} OAuth`,
        },
      });
      if (result.authorizationUrl === null) {
        setOauthBusy(false);
        setAddError("OAuth start did not produce an authorization URL");
        return;
      }
      oauthSessionId.current = result.sessionId;
      oauthCleanup.current = openOAuthPopup<OAuthTokens>({
        url: result.authorizationUrl,
        popupName: "graphql-oauth",
        channelName: OAUTH_POPUP_MESSAGE_TYPE,
        expectedSessionId: result.sessionId,
        onResult: (data: OAuthPopupResult<OAuthTokens>) => {
          oauthCleanup.current = null;
          oauthSessionId.current = null;
          setOauthBusy(false);
          if (data.ok) {
            setTokens({
              connectionId: data.connectionId,
              expiresAt: data.expiresAt,
              scope: data.scope,
            });
          } else {
            setAddError(data.error);
          }
        },
        onClosed: () => {
          const sessionId = result.sessionId;
          oauthCleanup.current = null;
          oauthSessionId.current = null;
          void doCancelOAuth({
            path: { scopeId },
            payload: { sessionId },
          }).catch(() => undefined);
          setOauthBusy(false);
          setAddError(
            "Sign-in cancelled — popup was closed before completing the flow.",
          );
        },
        onOpenFailed: () => {
          const sessionId = result.sessionId;
          oauthCleanup.current = null;
          oauthSessionId.current = null;
          void doCancelOAuth({
            path: { scopeId },
            payload: { sessionId },
          }).catch(() => undefined);
          setOauthBusy(false);
          setAddError("Sign-in popup was blocked by the browser");
        },
      });
    } catch (e) {
      setOauthBusy(false);
      setAddError(e instanceof Error ? e.message : "Failed to start OAuth");
    }
  }, [
    endpoint,
    credentials,
    scopeId,
    doStartOAuth,
    doCancelOAuth,
    cancelActiveOAuth,
    sourceIdentity,
  ]);

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    const { headers: headerMap, queryParams } =
      serializeHttpCredentials(credentials);

    const { trimmedEndpoint, namespace, displayName } = sourceIdentity();
    const placeholder = beginAdd({
      id: namespace,
      name: displayName,
      kind: "graphql",
      url: trimmedEndpoint || undefined,
    });
    try {
      await doAdd({
        path: { scopeId },
        payload: {
          endpoint: trimmedEndpoint,
          name: identity.name.trim() || undefined,
          namespace: slugifyNamespace(identity.namespace) || undefined,
          ...(Object.keys(headerMap).length > 0 ? { headers: headerMap } : {}),
          ...(Object.keys(queryParams).length > 0
            ? { queryParams: queryParams as Record<string, HeaderValue> }
            : {}),
          ...(authMode === "oauth2" && tokens
            ? {
                auth: {
                  kind: "oauth2" as const,
                  connectionId: tokens.connectionId,
                },
              }
            : {}),
        },
        reactivityKeys: sourceWriteKeys,
      });
      props.onComplete();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    } finally {
      placeholder.done();
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <h1 className="text-xl font-semibold text-foreground">
        Add GraphQL Source
      </h1>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField
            label="Endpoint"
            hint="The endpoint will be introspected to discover available queries and mutations."
          >
            <Input
              value={endpoint}
              onChange={(e) =>
                setEndpoint((e.target as HTMLInputElement).value)
              }
              placeholder="https://api.example.com/graphql"
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <SourceIdentityFields
        identity={identity}
        namePlaceholder="e.g. Shopify API"
      />

      <HttpCredentialsEditor
        credentials={credentials}
        onChange={setCredentials}
        existingSecrets={secretList}
        sourceName={identity.name}
        targetScope={scopeId}
      />

      <section className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">
            Authentication
          </span>
          <FilterTabs<AuthMode>
            tabs={[
              { value: "none", label: "None" },
              { value: "oauth2", label: "OAuth" },
            ]}
            value={authMode}
            onChange={(value) => {
              setAuthMode(value);
              setTokens(null);
            }}
          />
        </div>

        {authMode === "oauth2" && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2.5">
            {tokens ? (
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                Authenticated
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                Sign in before adding so Executor can introspect the schema.
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto h-7 px-2 text-xs"
              onClick={() => void handleOAuth()}
              disabled={
                !endpoint.trim() ||
                !httpCredentialsValid(credentials) ||
                oauthBusy
              }
            >
              {oauthBusy ? "Signing in..." : tokens ? "Reconnect" : "Sign in"}
            </Button>
          </div>
        )}
      </section>

      {/* Error */}
      {addError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{addError}</p>
        </div>
      )}

      <FloatActions>
        <Button
          variant="ghost"
          onClick={() => {
            cancelActiveOAuth();
            props.onCancel();
          }}
          disabled={adding}
        >
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={!canAdd || adding}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? "Adding..." : "Add source"}
        </Button>
      </FloatActions>
    </div>
  );
}

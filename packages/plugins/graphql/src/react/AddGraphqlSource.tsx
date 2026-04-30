import { useCallback, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { usePendingSources } from "@executor/react/api/optimistic";
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
import {
  oauthCallbackUrl,
  oauthConnectionId,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor/react/plugins/oauth-sign-in";
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

export default function AddGraphqlSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
}) {
  const [endpoint, setEndpoint] = useState(props.initialUrl ?? "");
  const identity = useSourceIdentity({
    fallbackName: displayNameFromUrl(endpoint) ?? "",
  });
  const [credentials, setCredentials] = useState<HttpCredentialsState>(initialGraphqlCredentials);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("none");
  const [tokens, setTokens] = useState<OAuthCompletionPayload | null>(null);

  const scopeId = useScope();
  const doAdd = useAtomSet(addGraphqlSource, { mode: "promise" });
  const { beginAdd } = usePendingSources();
  const secretList = useSecretPickerSecrets();
  const oauth = useOAuthPopupFlow({
    popupName: "graphql-oauth",
    startErrorMessage: "Failed to start OAuth",
  });

  const canAdd =
    endpoint.trim().length > 0 &&
    httpCredentialsValid(credentials) &&
    (authMode === "none" || tokens !== null) &&
    !oauth.busy;

  const sourceIdentity = useCallback(() => {
    const trimmedEndpoint = endpoint.trim();
    const namespace =
      slugifyNamespace(identity.namespace) ||
      slugifyNamespace(displayNameFromUrl(trimmedEndpoint) ?? "") ||
      "graphql";
    const displayName = identity.name.trim() || displayNameFromUrl(trimmedEndpoint) || namespace;
    return { trimmedEndpoint, namespace, displayName };
  }, [endpoint, identity.name, identity.namespace]);

  const handleOAuth = useCallback(async () => {
    if (!endpoint.trim() || !httpCredentialsValid(credentials)) return;
    setAddError(null);
    const { trimmedEndpoint, namespace, displayName } = sourceIdentity();
    const { headers, queryParams } = serializeHttpCredentials(credentials);
    await oauth.start({
      payload: {
        endpoint: trimmedEndpoint,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
        redirectUrl: oauthCallbackUrl(),
        connectionId: oauthConnectionId({ pluginId: "graphql", namespace }),
        strategy: { kind: "dynamic-dcr" },
        pluginId: "graphql",
        identityLabel: `${displayName} OAuth`,
      },
      onSuccess: (result) => {
        setTokens({
          connectionId: result.connectionId,
          expiresAt: result.expiresAt,
          scope: result.scope,
        });
      },
      onError: setAddError,
    });
  }, [endpoint, credentials, oauth, sourceIdentity]);

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    const { headers: headerMap, queryParams } = serializeHttpCredentials(credentials);

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
      <h1 className="text-xl font-semibold text-foreground">Add GraphQL Source</h1>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField
            label="Endpoint"
            hint="The endpoint will be introspected to discover available queries and mutations."
          >
            <Input
              value={endpoint}
              onChange={(e) => setEndpoint((e.target as HTMLInputElement).value)}
              placeholder="https://api.example.com/graphql"
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <SourceIdentityFields identity={identity} namePlaceholder="e.g. Shopify API" />

      <HttpCredentialsEditor
        credentials={credentials}
        onChange={setCredentials}
        existingSecrets={secretList}
        sourceName={identity.name}
        targetScope={scopeId}
      />

      <section className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">Authentication</span>
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
              disabled={!endpoint.trim() || !httpCredentialsValid(credentials) || oauth.busy}
            >
              {oauth.busy ? "Signing in..." : tokens ? "Reconnect" : "Sign in"}
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
            oauth.cancel();
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

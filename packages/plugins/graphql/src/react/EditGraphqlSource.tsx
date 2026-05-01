import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { graphqlSourceAtom, updateGraphqlSource } from "./atoms";
import { useScope } from "@executor-js/react/api/scope-context";
import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import {
  HttpCredentialsEditor,
  httpCredentialsFromValues,
  serializeHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/react/plugins/http-credentials";
import {
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor-js/react/plugins/source-identity";
import { Button } from "@executor-js/react/components/button";
import { FilterTabs } from "@executor-js/react/components/filter-tabs";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { Input } from "@executor-js/react/components/input";
import { Badge } from "@executor-js/react/components/badge";
import type { HeaderValue } from "../sdk/types";
import type { StoredGraphqlSource } from "../sdk/store";

// UI only needs the fields the API exposes; `scope` on the SDK interface
// isn't part of the HTTP response.
type EditableSource = Omit<StoredGraphqlSource, "scope">;
type AuthMode = "none" | "oauth2";

const graphqlOAuthConnectionId = (namespaceSlug: string): string =>
  `graphql-oauth2-${namespaceSlug || "default"}`;

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

function EditForm(props: { sourceId: string; initial: EditableSource; onSave: () => void }) {
  const scopeId = useScope();
  const doUpdate = useAtomSet(updateGraphqlSource as any, { mode: "promise" } as any) as any;
  const secretList = useSecretPickerSecrets();

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [endpoint, setEndpoint] = useState(props.initial.endpoint);
  const [credentials, setCredentials] = useState<HttpCredentialsState>(() =>
    httpCredentialsFromValues({
      headers: props.initial.headers,
      queryParams: props.initial.queryParams,
    }),
  );
  const [authMode, setAuthMode] = useState<AuthMode>(props.initial.auth.kind);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const identityDirty = identity.name.trim() !== props.initial.name.trim();

  const handleCredentialsChange = (next: HttpCredentialsState) => {
    setCredentials(next);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const { headers, queryParams } = serializeHttpCredentials(credentials);
    try {
      await doUpdate({
        params: { scopeId, namespace: props.sourceId },
        payload: {
          name: identity.name.trim() || undefined,
          endpoint: endpoint.trim() || undefined,
          headers,
          queryParams: queryParams as Record<string, HeaderValue>,
          auth:
            authMode === "oauth2"
              ? {
                  kind: "oauth2",
                  connectionId:
                    props.initial.auth.kind === "oauth2"
                      ? props.initial.auth.connectionId
                      : graphqlOAuthConnectionId(props.initial.namespace),
                }
              : { kind: "none" },
        },
        reactivityKeys: sourceWriteKeys,
      });
      setDirty(false);
      props.onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update source");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit GraphQL Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the endpoint and authentication headers for this source.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-xs">
          GraphQL
        </Badge>
      </div>

      <SourceIdentityFields identity={identity} namespaceReadOnly />

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Endpoint">
            <Input
              value={endpoint}
              onChange={(e) => {
                setEndpoint((e.target as HTMLInputElement).value);
                setDirty(true);
              }}
              placeholder="https://api.example.com/graphql"
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <HttpCredentialsEditor
        credentials={credentials}
        onChange={handleCredentialsChange}
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
              setDirty(true);
            }}
          />
        </div>
        {authMode === "oauth2" && (
          <p className="text-xs text-muted-foreground">
            OAuth sign-in is available from the source header after saving.
          </p>
        )}
      </section>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={(!dirty && !identityDirty) || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EditGraphqlSource(props: { sourceId: string; onSave: () => void }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(graphqlSourceAtom(scopeId, props.sourceId) as any) as any;

  if (!AsyncResult.isSuccess(sourceResult as any) || !sourceResult.value) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit GraphQL Source</h1>
          <p className="mt-1 text-sm text-muted-foreground">Loading configuration…</p>
        </div>
      </div>
    );
  }

  return (
    <EditForm
      sourceId={props.sourceId}
      initial={sourceResult.value as EditableSource}
      onSave={props.onSave}
    />
  );
}

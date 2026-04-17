import { useState } from "react";
import { useAtomValue, useAtomSet, Result } from "@effect-atom/atom-react";
import { graphqlSourceAtom, updateGraphqlSource } from "./atoms";
import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import {
  headerValueToState,
  headersFromState,
  type HeaderState,
} from "@executor/react/plugins/secret-header-auth";
import { HeadersList } from "@executor/react/plugins/headers-list";
import {
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { FieldLabel } from "@executor/react/components/field";
import { Input } from "@executor/react/components/input";
import { Badge } from "@executor/react/components/badge";
import type { StoredGraphqlSource } from "../sdk/store";

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

function EditForm(props: {
  sourceId: string;
  initial: StoredGraphqlSource;
  onSave: () => void;
}) {
  const scopeId = useScope();
  const doUpdate = useAtomSet(updateGraphqlSource, { mode: "promise" });
  const secretList = useSecretPickerSecrets();

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [endpoint, setEndpoint] = useState(props.initial.endpoint);
  const [headers, setHeaders] = useState<HeaderState[]>(() =>
    Object.entries(props.initial.headers ?? {}).map(([name, value]) =>
      headerValueToState(name, value),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const identityDirty = identity.name.trim() !== props.initial.name.trim();

  const handleHeadersChange = (next: HeaderState[]) => {
    setHeaders(next);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await doUpdate({
        path: { scopeId, namespace: props.sourceId },
        payload: {
          name: identity.name.trim() || undefined,
          endpoint: endpoint.trim() || undefined,
          headers: headersFromState(headers),
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

      <section className="space-y-2.5">
        <FieldLabel>Headers</FieldLabel>
        <HeadersList
          headers={headers}
          onHeadersChange={handleHeadersChange}
          existingSecrets={secretList}
          sourceName={identity.name}
        />
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
  const sourceResult = useAtomValue(graphqlSourceAtom(scopeId, props.sourceId));

  if (!Result.isSuccess(sourceResult) || !sourceResult.value) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit GraphQL Source</h1>
          <p className="mt-1 text-sm text-muted-foreground">Loading configuration…</p>
        </div>
      </div>
    );
  }

  return <EditForm sourceId={props.sourceId} initial={sourceResult.value} onSave={props.onSave} />;
}

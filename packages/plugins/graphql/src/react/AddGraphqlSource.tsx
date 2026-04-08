import { useState } from "react";
import { useAtomSet, useAtomValue, useAtomRefresh, Result } from "@effect-atom/atom-react";

import { secretsAtom, setSecret } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { SecretPicker, type SecretPickerSecret } from "@executor/react/plugins/secret-picker";
import { SecretId } from "@executor/core";
import { Button } from "@executor/react/components/button";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Spinner } from "@executor/react/components/spinner";
import { addGraphqlSource } from "./atoms";
import type { HeaderValue } from "../sdk/types";

// ---------------------------------------------------------------------------
// Inline secret creation
// ---------------------------------------------------------------------------

function InlineCreateSecret(props: {
  headerName: string;
  suggestedId: string;
  onCreated: (secretId: string) => void;
  onCancel: () => void;
}) {
  const [secretId, setSecretId] = useState(props.suggestedId);
  const [secretName, setSecretName] = useState(props.headerName);
  const [secretValue, setSecretValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeId = useScope();
  const doSet = useAtomSet(setSecret, { mode: "promise" });
  const refreshSecrets = useAtomRefresh(secretsAtom(scopeId));

  const handleSave = async () => {
    if (!secretId.trim() || !secretValue.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await doSet({
        path: { scopeId },
        payload: {
          id: SecretId.make(secretId.trim()),
          name: secretName.trim() || secretId.trim(),
          value: secretValue.trim(),
          purpose: `Auth header: ${props.headerName}`,
        },
      });
      refreshSecrets();
      props.onCreated(secretId.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save secret");
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.02] p-3 space-y-2.5">
      <p className="text-[11px] font-semibold text-primary tracking-wide uppercase">New secret</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">ID</Label>
          <Input
            value={secretId}
            onChange={(e) => setSecretId((e.target as HTMLInputElement).value)}
            placeholder="my-api-token"
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Label</Label>
          <Input
            value={secretName}
            onChange={(e) => setSecretName((e.target as HTMLInputElement).value)}
            placeholder="API Token"
            className="h-8 text-xs"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Value</Label>
        <Input
          type="password"
          value={secretValue}
          onChange={(e) => setSecretValue((e.target as HTMLInputElement).value)}
          placeholder="paste your token or key..."
          className="h-8 text-xs font-mono"
        />
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex gap-1.5 pt-0.5">
        <Button variant="outline" size="xs" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={handleSave}
          disabled={!secretId.trim() || !secretValue.trim() || saving}
        >
          {saving ? "Saving..." : "Create & use"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth header row
// ---------------------------------------------------------------------------

function AuthHeaderRow(props: {
  selectedSecretId: string | null;
  onSelect: (secretId: string) => void;
  existingSecrets: readonly SecretPickerSecret[];
}) {
  const [creating, setCreating] = useState(false);
  const { selectedSecretId, onSelect, existingSecrets } = props;

  if (creating) {
    return (
      <InlineCreateSecret
        headerName="Authorization"
        suggestedId="graphql-auth-token"
        onCreated={(id) => {
          onSelect(id);
          setCreating(false);
        }}
        onCancel={() => setCreating(false)}
      />
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0">
          <SecretPicker
            value={selectedSecretId}
            onSelect={onSelect}
            secrets={existingSecrets}
          />
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setCreating(true)}>
          + New
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AddGraphqlSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
}) {
  const [endpoint, setEndpoint] = useState(props.initialUrl ?? "");
  const [namespace, setNamespace] = useState("");
  const [authSecretId, setAuthSecretId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const doAdd = useAtomSet(addGraphqlSource, { mode: "promise" });
  const secrets = useAtomValue(secretsAtom(scopeId));

  const secretList: readonly SecretPickerSecret[] = Result.match(secrets, {
    onInitial: () => [] as SecretPickerSecret[],
    onFailure: () => [] as SecretPickerSecret[],
    onSuccess: ({ value }) =>
      value.map((s) => ({
        id: s.id,
        name: s.name,
        provider: s.provider ? String(s.provider) : undefined,
      })),
  });

  const canAdd = endpoint.trim().length > 0;

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    try {
      const headers: Record<string, HeaderValue> = {};
      if (authSecretId) {
        headers["Authorization"] = { secretId: authSecretId, prefix: "Bearer " };
      }

      await doAdd({
        path: { scopeId },
        payload: {
          endpoint: endpoint.trim(),
          namespace: namespace.trim() || undefined,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      });
      props.onComplete();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-foreground">Add GraphQL Source</h1>

      {/* Endpoint */}
      <section className="space-y-2">
        <Label>GraphQL Endpoint</Label>
        <Input
          value={endpoint}
          onChange={(e) => setEndpoint((e.target as HTMLInputElement).value)}
          placeholder="https://api.example.com/graphql"
          className="font-mono text-sm"
        />
        <p className="text-[12px] text-muted-foreground">
          The endpoint will be introspected to discover available queries and mutations.
        </p>
      </section>

      {/* Namespace */}
      <section className="space-y-2">
        <Label>
          Namespace <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          value={namespace}
          onChange={(e) => setNamespace((e.target as HTMLInputElement).value)}
          placeholder="my_api"
          className="font-mono text-sm"
        />
        <p className="text-[12px] text-muted-foreground">
          A prefix for the tool names. Derived from the endpoint hostname if not provided.
        </p>
      </section>

      {/* Authentication */}
      <section className="space-y-2.5">
        <Label>
          Authentication <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <p className="text-[12px] text-muted-foreground">
          Select a secret for the Bearer token sent with every request, including introspection.
        </p>
        <AuthHeaderRow
          selectedSecretId={authSecretId}
          onSelect={setAuthSecretId}
          existingSecrets={secretList}
        />
      </section>

      {/* Error */}
      {addError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{addError}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={!canAdd || adding}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? "Adding..." : "Add source"}
        </Button>
      </div>
    </div>
  );
}

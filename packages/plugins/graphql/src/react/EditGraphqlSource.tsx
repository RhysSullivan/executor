import { useState, useMemo } from "react";
import { useAtomValue, useAtomSet, useAtomRefresh, Result } from "@effect-atom/atom-react";
import { sourceConfigAtom, updateSource, secretsAtom } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Badge } from "@executor/react/components/badge";
import { SecretPicker, type SecretPickerSecret } from "@executor/react/plugins/secret-picker";
import type { HeaderValue } from "../sdk/types";

// ---------------------------------------------------------------------------
// Header row
// ---------------------------------------------------------------------------

function HeaderRow(props: {
  name: string;
  value: HeaderValue;
  onChange: (name: string, value: HeaderValue) => void;
  onRemove: () => void;
  secrets: readonly SecretPickerSecret[];
}) {
  const { name, value, onChange, onRemove, secrets } = props;
  const isSecretRef = typeof value === "object" && value !== null && "secretId" in value;
  const secretId = isSecretRef ? (value as { secretId: string }).secretId : null;
  const prefix = isSecretRef ? (value as { prefix?: string }).prefix : undefined;

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Header</Label>
        <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Name</Label>
          <Input
            value={name}
            onChange={(e) => onChange((e.target as HTMLInputElement).value, value)}
            placeholder="Authorization"
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Prefix</Label>
          <Input
            value={prefix ?? ""}
            onChange={(e) => {
              const p = (e.target as HTMLInputElement).value || undefined;
              if (secretId) {
                onChange(name, { secretId, ...(p ? { prefix: p } : {}) });
              }
            }}
            placeholder="Bearer "
            className="h-8 text-xs font-mono"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Secret</Label>
        <SecretPicker
          value={secretId}
          onSelect={(id) => onChange(name, { secretId: id, ...(prefix ? { prefix } : {}) })}
          secrets={secrets}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EditGraphqlSource(props: {
  sourceId: string;
  onSave: () => void;
}) {
  const scopeId = useScope();
  const configResult = useAtomValue(sourceConfigAtom(props.sourceId, scopeId));
  const refreshConfig = useAtomRefresh(sourceConfigAtom(props.sourceId, scopeId));
  const doUpdate = useAtomSet(updateSource, { mode: "promise" });
  const secrets = useAtomValue(secretsAtom(scopeId));

  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [headers, setHeaders] = useState<Record<string, HeaderValue> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const config = Result.isSuccess(configResult) ? configResult.value : null;

  const currentEndpoint = endpoint ?? (config as any)?.endpoint ?? "";
  const currentHeaders: Record<string, HeaderValue> = headers ?? (config as any)?.headers ?? {};

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

  const headerEntries = useMemo(
    () => Object.entries(currentHeaders),
    [currentHeaders],
  );

  const updateEndpoint_ = (value: string) => {
    setEndpoint(value);
    setDirty(true);
  };

  const updateHeader = (oldName: string, newName: string, value: HeaderValue) => {
    const next = { ...currentHeaders };
    if (oldName !== newName) {
      delete next[oldName];
    }
    next[newName] = value;
    setHeaders(next);
    setDirty(true);
  };

  const removeHeader = (name: string) => {
    const next = { ...currentHeaders };
    delete next[name];
    setHeaders(next);
    setDirty(true);
  };

  const addHeader = () => {
    const next = { ...currentHeaders, "": { secretId: "" } };
    setHeaders(next);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (endpoint !== null) payload.endpoint = currentEndpoint;
      if (headers !== null) payload.headers = currentHeaders;

      await doUpdate({
        path: { scopeId, sourceId: props.sourceId },
        payload,
      });
      refreshConfig();
      setDirty(false);
      props.onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update source");
    } finally {
      setSaving(false);
    }
  };

  if (!Result.isSuccess(configResult)) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit GraphQL Source</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Loading configuration...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit GraphQL Source</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Update the endpoint and authentication headers for this source.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-[10px]">
          GraphQL
        </Badge>
      </div>

      {/* Endpoint */}
      <section className="space-y-2">
        <Label>Endpoint</Label>
        <Input
          value={currentEndpoint}
          onChange={(e) => updateEndpoint_((e.target as HTMLInputElement).value)}
          placeholder="https://api.example.com/graphql"
          className="font-mono text-sm"
        />
      </section>

      {/* Headers */}
      <section className="space-y-2.5">
        <Label>Headers</Label>
        {headerEntries.map(([name, value]) => (
          <HeaderRow
            key={name}
            name={name}
            value={value}
            onChange={(newName, newValue) => updateHeader(name, newName, newValue)}
            onRemove={() => removeHeader(name)}
            secrets={secretList}
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          className="w-full border-dashed"
          onClick={addHeader}
        >
          + Add header
        </Button>
      </section>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

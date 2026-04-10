import { useState } from "react";
import { useAtomValue, useAtomSet, useAtomRefresh, Result } from "@effect-atom/atom-react";
import { openApiSourceAtom, updateOpenApiSource } from "./atoms";
import { useScope } from "@executor/react/api/scope-context";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import {
  SecretHeaderAuthRow,
  headerValueToState,
  headersFromState,
  type HeaderState,
} from "@executor/react/plugins/secret-header-auth";
import { Button } from "@executor/react/components/button";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Badge } from "@executor/react/components/badge";
import type { StoredSourceSchemaType } from "../sdk/stored-source";

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

function EditForm(props: {
  sourceId: string;
  initial: StoredSourceSchemaType;
  onSave: () => void;
}) {
  const scopeId = useScope();
  const doUpdate = useAtomSet(updateOpenApiSource, { mode: "promise" });
  const refreshSource = useAtomRefresh(openApiSourceAtom(scopeId, props.sourceId));
  const secretList = useSecretPickerSecrets();

  const [baseUrl, setBaseUrl] = useState(props.initial.config.baseUrl ?? "");
  const [headers, setHeaders] = useState<HeaderState[]>(() =>
    Object.entries(props.initial.config.headers ?? {}).map(([name, value]) =>
      headerValueToState(name, value),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const updateHeader = (index: number, update: Partial<HeaderState>) => {
    setHeaders((prev) => prev.map((h, i) => (i === index ? { ...h, ...update } : h)));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await doUpdate({
        path: { scopeId, namespace: props.sourceId },
        payload: {
          baseUrl: baseUrl.trim() || undefined,
          headers: headersFromState(headers),
        },
      });
      refreshSource();
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
        <h1 className="text-xl font-semibold text-foreground">Edit OpenAPI Source</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Update the base URL and authentication headers for this source.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-[10px]">OpenAPI</Badge>
      </div>

      <section className="space-y-2">
        <Label>Base URL</Label>
        <Input
          value={baseUrl}
          onChange={(e) => { setBaseUrl((e.target as HTMLInputElement).value); setDirty(true); }}
          placeholder="https://api.example.com"
          className="font-mono text-sm"
        />
      </section>

      <section className="space-y-2.5">
        <Label>Headers</Label>
        {headers.map((h, i) => (
          <SecretHeaderAuthRow
            key={i}
            name={h.name}
            prefix={h.prefix}
            presetKey={h.presetKey}
            secretId={h.secretId}
            onChange={(update) => updateHeader(i, update)}
            onSelectSecret={(secretId) => updateHeader(i, { secretId })}
            onRemove={() => { setHeaders((prev) => prev.filter((_, j) => j !== i)); setDirty(true); }}
            existingSecrets={secretList}
          />
        ))}
        <Button variant="outline" size="sm" className="w-full border-dashed" onClick={() => { setHeaders((prev) => [...prev, { name: "", secretId: null }]); setDirty(true); }}>
          + Add header
        </Button>
      </section>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave}>Cancel</Button>
        <Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EditOpenApiSource(props: {
  sourceId: string;
  onSave: () => void;
}) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(openApiSourceAtom(scopeId, props.sourceId));

  if (!Result.isSuccess(sourceResult) || !sourceResult.value) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit OpenAPI Source</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Loading configuration…</p>
        </div>
      </div>
    );
  }

  return <EditForm sourceId={props.sourceId} initial={sourceResult.value} onSave={props.onSave} />;
}

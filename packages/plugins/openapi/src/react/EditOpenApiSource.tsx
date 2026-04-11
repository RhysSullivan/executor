import { useState } from "react";
import { useAtomValue, useAtomSet, useAtomRefresh, Result } from "@effect-atom/atom-react";
import { openApiSourceAtom, updateOpenApiSource } from "./atoms";
import { useScope } from "@executor/react/api/scope-context";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import {
  headerValueToState,
  headersFromState,
  type HeaderState,
} from "@executor/react/plugins/secret-header-auth";
import { AuthenticationSection } from "@executor/react/plugins/authentication-section";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { Input } from "@executor/react/components/input";
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
        <Badge variant="secondary" className="text-[10px]">
          OpenAPI
        </Badge>
      </div>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Base URL">
            <Input
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl((e.target as HTMLInputElement).value);
                setDirty(true);
              }}
              placeholder="https://api.example.com"
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <AuthenticationSection
        methods={["header"]}
        value="header"
        onChange={() => {}}
        label="Headers"
        headers={headers}
        onHeadersChange={handleHeadersChange}
        existingSecrets={secretList}
      />

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
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EditOpenApiSource(props: { sourceId: string; onSave: () => void }) {
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

import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { mcpSourceAtom, updateMcpSource } from "./atoms";
import { useScope } from "@executor-js/react/api/scope-context";
import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor-js/react/plugins/source-identity";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import {
  HttpCredentialsEditor,
  httpCredentialsFromValues,
  serializeHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/react/plugins/http-credentials";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { Input } from "@executor-js/react/components/input";
import { Badge } from "@executor-js/react/components/badge";
import type { McpStoredSourceSchemaType } from "../sdk/stored-source";

// ---------------------------------------------------------------------------
// Remote edit form
// ---------------------------------------------------------------------------

function RemoteEditForm(props: {
  sourceId: string;
  initial: McpStoredSourceSchemaType & { config: { transport: "remote" } };
  onSave: () => void;
}) {
  const scopeId = useScope();
  const doUpdate = useAtomSet(updateMcpSource as never, { mode: "promise" } as never) as (
    input: unknown,
  ) => Promise<unknown>;
  const secretList = useSecretPickerSecrets();

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [endpoint, setEndpoint] = useState(props.initial.config.endpoint);
  const [credentials, setCredentials] = useState<HttpCredentialsState>(() =>
    httpCredentialsFromValues({
      headers: props.initial.config.headers,
      queryParams: props.initial.config.queryParams,
    }),
  );
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
          queryParams,
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
        <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the endpoint and headers for this MCP connection.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-xs">
          remote
        </Badge>
      </div>

      <SourceIdentityFields identity={identity} namespaceReadOnly />

      {/* Endpoint */}
      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Endpoint">
            <Input
              value={endpoint}
              onChange={(e) => {
                setEndpoint((e.target as HTMLInputElement).value);
                setDirty(true);
              }}
              placeholder="https://mcp.example.com"
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
      />

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
// Stdio read-only view
// ---------------------------------------------------------------------------

function StdioReadOnly(props: {
  sourceId: string;
  initial: McpStoredSourceSchemaType & { config: { transport: "stdio" } };
  onSave: () => void;
}) {
  const { command, args } = props.initial.config;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stdio MCP sources cannot be edited in the UI. Modify the executor.jsonc config file
          directly.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
          <p className="mt-0.5 text-xs text-muted-foreground font-mono">
            {command} {(args ?? []).join(" ")}
          </p>
        </div>
        <Badge variant="secondary" className="text-xs">
          stdio
        </Badge>
      </div>

      <div className="flex items-center justify-end border-t border-border pt-4">
        <Button onClick={props.onSave}>Done</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EditMcpSource({
  sourceId,
  onSave,
}: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(mcpSourceAtom(scopeId, sourceId)) as AsyncResult.AsyncResult<
    McpStoredSourceSchemaType | null,
    unknown
  >;

  if (!AsyncResult.isSuccess(sourceResult) || !sourceResult.value) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
          <p className="mt-1 text-sm text-muted-foreground">Loading configuration…</p>
        </div>
      </div>
    );
  }

  const source = sourceResult.value;

  if (source.config.transport === "stdio") {
    return (
      <StdioReadOnly
        sourceId={sourceId}
        initial={source as McpStoredSourceSchemaType & { config: { transport: "stdio" } }}
        onSave={onSave}
      />
    );
  }

  return (
    <RemoteEditForm
      sourceId={sourceId}
      initial={source as McpStoredSourceSchemaType & { config: { transport: "remote" } }}
      onSave={onSave}
    />
  );
}

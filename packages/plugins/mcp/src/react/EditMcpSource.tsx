import { useState } from "react";
import { useAtomValue, useAtomSet, useAtomRefresh, Result } from "@effect-atom/atom-react";
import { mcpSourceAtom, updateMcpSource } from "./atoms";
import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Badge } from "@executor/react/components/badge";
import type { McpStoredSourceSchemaType } from "../sdk/stored-source";

// ---------------------------------------------------------------------------
// Editable header entry
// ---------------------------------------------------------------------------

type HeaderEntry = {
  readonly name: string;
  readonly value: string;
};

// ---------------------------------------------------------------------------
// Remote edit form
// ---------------------------------------------------------------------------

function RemoteEditForm(props: {
  sourceId: string;
  initial: McpStoredSourceSchemaType & { config: { transport: "remote" } };
  onSave: () => void;
}) {
  const scopeId = useScope();
  const doUpdate = useAtomSet(updateMcpSource, { mode: "promise" });
  const refreshSource = useAtomRefresh(mcpSourceAtom(scopeId, props.sourceId));

  const [endpoint, setEndpoint] = useState(props.initial.config.endpoint);
  const [headerEntries, setHeaderEntries] = useState<HeaderEntry[]>(() =>
    Object.entries(props.initial.config.headers ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const updateHeader = (index: number, field: "name" | "value", val: string) => {
    setHeaderEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, [field]: val } : entry)),
    );
    setDirty(true);
  };

  const removeHeader = (index: number) => {
    setHeaderEntries((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const addHeader = () => {
    setHeaderEntries((prev) => [...prev, { name: "", value: "" }]);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const headersObj: Record<string, string> = {};
      for (const entry of headerEntries) {
        const name = entry.name.trim();
        if (name) headersObj[name] = entry.value;
      }

      await doUpdate({
        path: { scopeId, namespace: props.sourceId },
        payload: {
          endpoint: endpoint.trim() || undefined,
          headers: headersObj,
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
        <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Update the endpoint and headers for this MCP connection.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-[10px]">
          remote
        </Badge>
      </div>

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

      {/* Headers */}
      <section className="space-y-2.5">
        <Label>Headers</Label>
        {headerEntries.map((entry, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={entry.name}
              onChange={(e) => updateHeader(i, "name", (e.target as HTMLInputElement).value)}
              placeholder="Header name"
              className="h-8 text-xs font-mono flex-1"
            />
            <Input
              value={entry.value}
              onChange={(e) => updateHeader(i, "value", (e.target as HTMLInputElement).value)}
              placeholder="Header value"
              className="h-8 text-xs font-mono flex-1"
            />
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => removeHeader(i)}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="w-full border-dashed" onClick={addHeader}>
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
        <p className="mt-1 text-[13px] text-muted-foreground">
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
        <Badge variant="secondary" className="text-[10px]">
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
  const sourceResult = useAtomValue(mcpSourceAtom(scopeId, sourceId));

  if (!Result.isSuccess(sourceResult) || !sourceResult.value) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Loading configuration…</p>
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

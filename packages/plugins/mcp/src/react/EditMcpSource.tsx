import { useState, useMemo } from "react";
import { useAtomValue, useAtomSet, useAtomRefresh, Result } from "@effect-atom/atom-react";
import { sourceConfigAtom, updateSource } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Badge } from "@executor/react/components/badge";

// ---------------------------------------------------------------------------
// Edit MCP Source -- config view for an existing MCP source
// ---------------------------------------------------------------------------

export default function EditMcpSource({
  sourceId,
  onSave,
}: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const scopeId = useScope();
  const configResult = useAtomValue(sourceConfigAtom(sourceId, scopeId));
  const refreshConfig = useAtomRefresh(sourceConfigAtom(sourceId, scopeId));
  const doUpdate = useAtomSet(updateSource, { mode: "promise" });

  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [headerEntries, setHeaderEntries] = useState<Array<{ name: string; value: string }> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const config = Result.isSuccess(configResult) ? configResult.value : null;
  const isRemote = config && (config as any).transport === "remote";
  const isStdio = config && (config as any).transport === "stdio";

  // Initialize form state from config
  const currentEndpoint = endpoint ?? (config as any)?.endpoint ?? "";
  const currentHeaders = useMemo(() => {
    if (headerEntries !== null) return headerEntries;
    const raw = (config as any)?.headers as Record<string, string> | undefined;
    if (!raw) return [];
    return Object.entries(raw).map(([name, value]) => ({ name, value }));
  }, [headerEntries, config]);

  const updateEndpoint = (value: string) => {
    setEndpoint(value);
    setDirty(true);
  };

  const updateHeaderEntry = (index: number, field: "name" | "value", val: string) => {
    const next = [...currentHeaders];
    next[index] = { ...next[index], [field]: val };
    setHeaderEntries(next);
    setDirty(true);
  };

  const removeHeaderEntry = (index: number) => {
    setHeaderEntries(currentHeaders.filter((_, i) => i !== index));
    setDirty(true);
  };

  const addHeaderEntry = () => {
    setHeaderEntries([...currentHeaders, { name: "", value: "" }]);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (endpoint !== null) payload.endpoint = currentEndpoint;
      if (headerEntries !== null) {
        const headersObj: Record<string, string> = {};
        for (const entry of currentHeaders) {
          if (entry.name.trim()) {
            headersObj[entry.name.trim()] = entry.value;
          }
        }
        payload.headers = headersObj;
      }

      await doUpdate({
        path: { scopeId, sourceId },
        payload,
      });
      refreshConfig();
      setDirty(false);
      onSave();
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
          <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Loading configuration...</p>
        </div>
      </div>
    );
  }

  if (isStdio) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Stdio MCP sources cannot be edited in the UI. Modify the executor.jsonc config file directly.
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-card-foreground">{sourceId}</p>
            <p className="mt-0.5 text-xs text-muted-foreground font-mono">
              {(config as any)?.command} {((config as any)?.args ?? []).join(" ")}
            </p>
          </div>
          <Badge variant="secondary" className="text-[10px]">
            stdio
          </Badge>
        </div>

        <div className="flex items-center justify-end border-t border-border pt-4">
          <Button onClick={onSave}>Done</Button>
        </div>
      </div>
    );
  }

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
          <p className="truncate text-sm font-semibold text-card-foreground">{sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-[10px]">
          {isRemote ? "remote" : "MCP"}
        </Badge>
      </div>

      {/* Endpoint */}
      {isRemote && (
        <section className="space-y-2">
          <Label>Endpoint</Label>
          <Input
            value={currentEndpoint}
            onChange={(e) => updateEndpoint((e.target as HTMLInputElement).value)}
            placeholder="https://mcp.example.com"
            className="font-mono text-sm"
          />
        </section>
      )}

      {/* Headers */}
      {isRemote && (
        <section className="space-y-2.5">
          <Label>Headers</Label>
          {currentHeaders.map((entry, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={entry.name}
                onChange={(e) => updateHeaderEntry(i, "name", (e.target as HTMLInputElement).value)}
                placeholder="Header name"
                className="h-8 text-xs font-mono flex-1"
              />
              <Input
                value={entry.value}
                onChange={(e) => updateHeaderEntry(i, "value", (e.target as HTMLInputElement).value)}
                placeholder="Header value"
                className="h-8 text-xs font-mono flex-1"
              />
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-destructive shrink-0"
                onClick={() => removeHeaderEntry(i)}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-full border-dashed"
            onClick={addHeaderEntry}
          >
            + Add header
          </Button>
        </section>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={onSave}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

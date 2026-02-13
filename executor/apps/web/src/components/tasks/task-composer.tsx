"use client";

import { useEffect, useState } from "react";
import { Play, Send } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CodeEditor } from "@/components/tasks/code-editor";
import { convexApi } from "@/lib/convex-api";
import { useSession } from "@/lib/session-context";
import type { RuntimeTargetDescriptor } from "@/lib/types";
import { useWorkspaceTools } from "@/hooks/use-workspace-tools";

const DEFAULT_CODE = `// Example: discover tools and return matching tool names
const found = await tools.discover({
  query: "Discover",
});

return found.results.map((tool) => tool.path);`;
const DEFAULT_TIMEOUT_MS = 300_000;

export function TaskComposer() {
  const { context } = useSession();
  const [code, setCode] = useState(DEFAULT_CODE);
  const [runtimeId, setRuntimeId] = useState("local-bun");
  const [timeoutMs, setTimeoutMs] = useState(String(DEFAULT_TIMEOUT_MS));
  const [submitting, setSubmitting] = useState(false);

  const runtimes = useQuery(convexApi.workspace.listRuntimeTargets, {});
  const createTask = useMutation(convexApi.executor.createTask);
  const { tools, dtsUrls, loadingTools, loadingTypes } = useWorkspaceTools(context ?? null);
  const runtimeTargets = runtimes ?? [];

  useEffect(() => {
    if (runtimeTargets.length === 0) {
      return;
    }
    if (!runtimeTargets.some((runtime: RuntimeTargetDescriptor) => runtime.id === runtimeId)) {
      setRuntimeId(runtimeTargets[0]!.id);
    }
  }, [runtimeId, runtimeTargets]);

  const handleSubmit = async () => {
    if (!context || !code.trim()) return;
    setSubmitting(true);
    try {
      const selectedRuntimeId = runtimeTargets.some((runtime: RuntimeTargetDescriptor) => runtime.id === runtimeId)
        ? runtimeId
        : undefined;
      const data = await createTask({
        code,
        runtimeId: selectedRuntimeId,
        timeoutMs: Number.parseInt(timeoutMs, 10) || DEFAULT_TIMEOUT_MS,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        clientId: context.clientId,
      });
      toast.success(`Task created: ${data.task.id}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create task",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Play className="h-4 w-4 text-terminal-green" />
          New Task
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Runtime</Label>
            <Select value={runtimeId} onValueChange={setRuntimeId}>
              <SelectTrigger className="h-8 text-xs font-mono bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {runtimeTargets.map((r: RuntimeTargetDescriptor) => (
                  <SelectItem key={r.id} value={r.id} className="text-xs">
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Timeout (ms)
            </Label>
            <Input
              type="number"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              className="h-8 text-xs font-mono bg-background"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs text-muted-foreground">Code</Label>
            <span className="text-[10px] font-mono text-muted-foreground">
              {loadingTools
                ? "Loading tool inventory..."
                : loadingTypes
                  ? `${tools.length} tool${tools.length === 1 ? "" : "s"} loaded, type defs warming...`
                  : `${tools.length} tool${tools.length === 1 ? "" : "s"} ready`}
            </span>
          </div>
          {!loadingTools && loadingTypes && tools.length > 0 && (
            <div className="flex flex-wrap gap-1.5 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5">
              {tools.slice(0, 8).map((tool) => (
                <span
                  key={tool.path}
                  className="rounded bg-background px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
                >
                  {tool.path}
                </span>
              ))}
              {tools.length > 8 && (
                <span className="rounded bg-background px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                  +{tools.length - 8} more
                </span>
              )}
            </div>
          )}
          <div className="rounded-md border border-border">
            <CodeEditor
              value={code}
              onChange={setCode}
              tools={tools}
              dtsUrls={dtsUrls}
              typesLoading={loadingTypes}
              height="400px"
            />
          </div>
        </div>
        <Button
          onClick={handleSubmit}
          disabled={submitting || !code.trim()}
          className="w-full bg-primary text-primary-foreground hover:bg-primary/90 h-9"
          size="sm"
        >
          <Send className="h-3.5 w-3.5 mr-2" />
          {submitting ? "Creating..." : "Execute Task"}
        </Button>
      </CardContent>
    </Card>
  );
}

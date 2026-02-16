"use client";

import { useMemo, useState } from "react";
import { Send } from "lucide-react";
import { useAction } from "convex/react";
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
import { FormattedCodeBlock } from "@/components/formatted/code-block";
import { convexApi } from "@/lib/convex-api";
import { useSession } from "@/lib/session-context";
import type { RuntimeTargetDescriptor } from "@/lib/types";
import { listRuntimeTargets } from "@/lib/runtime-targets";
import { useWorkspaceTools } from "@/hooks/use/workspace-tools";

const DEFAULT_CODE = `// Example: discover tools and return matching tool names
const found = await tools.discover({
  query: "Discover",
});

return found.results.map((tool) => tool.path);`;
const DEFAULT_TIMEOUT_MS = 300_000;

function formatExecutionValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function TaskComposer() {
  const { context } = useSession();
  const [code, setCode] = useState(DEFAULT_CODE);
  const [runtimeId, setRuntimeId] = useState("local-bun");
  const [timeoutMs, setTimeoutMs] = useState(String(DEFAULT_TIMEOUT_MS));
  const [submitting, setSubmitting] = useState(false);
  const [lastExecution, setLastExecution] = useState<{
    taskId: string;
    status: string;
    result?: string;
    error?: string;
  } | null>(null);

  const runtimeTargets = useMemo(() => listRuntimeTargets(), []);
  const createTask = useAction(convexApi.executor.createTask);
  const { tools, typesUrl, loadingTools } = useWorkspaceTools(context ?? null);
  const effectiveRuntimeId = runtimeTargets.some((runtime: RuntimeTargetDescriptor) => runtime.id === runtimeId)
    ? runtimeId
    : runtimeTargets[0]?.id ?? "";

  const handleSubmit = async () => {
    if (!context || !code.trim()) return;
    setSubmitting(true);
    try {
      const selectedRuntimeId = effectiveRuntimeId || undefined;
      const data = await createTask({
        code,
        runtimeId: selectedRuntimeId,
        timeoutMs: Number.parseInt(timeoutMs, 10) || DEFAULT_TIMEOUT_MS,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        clientId: context.clientId,
        waitForResult: true,
      });

      setLastExecution({
        taskId: data.task.id,
        status: data.task.status,
        ...(data.result !== undefined
          ? { result: formatExecutionValue(data.result) }
          : {}),
        ...(data.task.error ? { error: data.task.error } : {}),
      });

      if (data.task.status === "completed") {
        toast.success(`Task completed: ${data.task.id}`);
      } else {
        toast.error(`Task ${data.task.status}: ${data.task.id}`);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to execute task",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Editor</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Runtime</Label>
            <Select value={effectiveRuntimeId} onValueChange={setRuntimeId}>
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
                : `${tools.length} tool${tools.length === 1 ? "" : "s"} loaded${typesUrl ? ", type defs ready" : ""}`}
            </span>
          </div>
          <div className="rounded-md border border-border">
            <CodeEditor
              value={code}
              onChange={setCode}
              tools={tools}
              typesUrl={typesUrl}
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
          {submitting ? "Executing..." : "Execute Task"}
        </Button>

        {lastExecution && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Last execution
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {lastExecution.status} - {lastExecution.taskId}
              </span>
            </div>

            {lastExecution.result !== undefined && (
              <div>
                <span className="text-[10px] uppercase tracking-widest text-terminal-green block mb-2">
                  Returned result
                </span>
                <FormattedCodeBlock
                  content={lastExecution.result}
                  language="json"
                  className="max-h-48 overflow-auto"
                />
              </div>
            )}

            {lastExecution.error && (
              <div>
                <span className="text-[10px] uppercase tracking-widest text-terminal-red block mb-2">
                  Error
                </span>
                <FormattedCodeBlock
                  content={lastExecution.error}
                  language="text"
                  tone="red"
                  className="max-h-48 overflow-auto"
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

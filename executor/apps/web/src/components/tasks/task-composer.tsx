"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { listRuntimeTargetsWithOptions } from "@/lib/runtime-targets";
import { useWorkspaceTools } from "@/hooks/use/workspace-tools";

const DEFAULT_CODE = `// Example: discover tools and return matching tool names
const found = await tools.discover({
  query: "Discover",
});

return found.results.map((tool) => tool.path);`;
const DEFAULT_TIMEOUT_MS = 300_000;
const CODE_DRAFT_STORAGE_PREFIX = "executor-task-code-draft-v1";
const CODE_DRAFT_PENDING_KEY = "executor-task-code-draft-v1:pending";
const EDITOR_VIEW_STATE_STORAGE_PREFIX = "executor-task-editor-view-state-v1";

function getWorkspaceDraftKey(workspaceId: string | undefined) {
  return workspaceId ? makeStorageKey(CODE_DRAFT_STORAGE_PREFIX, workspaceId) : CODE_DRAFT_PENDING_KEY;
}

function makeStorageKey(prefix: string, workspaceId: string | undefined) {
  return `${prefix}:${workspaceId ?? "anonymous"}`;
}

function readCodeDraft(key: string) {
  try {
    const fromLocal = window.localStorage.getItem(key);
    if (fromLocal !== null) {
      return fromLocal;
    }

    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function readCodeDraftForWorkspace(workspaceId: string | undefined) {
  const workspaceKey = getWorkspaceDraftKey(workspaceId);
  const workspaceDraft = readCodeDraft(workspaceKey);
  if (workspaceDraft !== null) {
    return workspaceDraft;
  }

  if (workspaceId) {
    const pendingDraft = readCodeDraft(CODE_DRAFT_PENDING_KEY);
    if (pendingDraft !== null) {
      writeCodeDraft(workspaceKey, pendingDraft);
      return pendingDraft;
    }
  }

  return null;
}

function writeWorkspaceCodeDraft(workspaceId: string | undefined, value: string) {
  const workspaceKey = getWorkspaceDraftKey(workspaceId);
  writeCodeDraft(workspaceKey, value);
  if (!workspaceId) {
    writeCodeDraft(CODE_DRAFT_PENDING_KEY, value);
  }
}

function writeCodeDraft(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
    return;
  } catch {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      return;
    }
  }
}

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
  const { context, clientConfig } = useSession();
  const [code, setCode] = useState(() => {
    return readCodeDraftForWorkspace(context?.workspaceId) ?? DEFAULT_CODE;
  });
  const [runtimeId, setRuntimeId] = useState("local-bun");
  const [timeoutMs, setTimeoutMs] = useState(String(DEFAULT_TIMEOUT_MS));
  const [submitting, setSubmitting] = useState(false);
  const [lastExecution, setLastExecution] = useState<{
    taskId: string;
    status: string;
    result?: string;
    error?: string;
  } | null>(null);
  const storageWorkspaceId = context?.workspaceId;
  const codeDraftStorageKey = useMemo(
    () => getWorkspaceDraftKey(storageWorkspaceId),
    [storageWorkspaceId],
  );
  const codeRef = useRef(code);
  const editorViewStateStorageKey = useMemo(
    () => makeStorageKey(EDITOR_VIEW_STATE_STORAGE_PREFIX, storageWorkspaceId),
    [storageWorkspaceId],
  );

  const runtimeTargets = useMemo(
    () => listRuntimeTargetsWithOptions({ allowLocalVm: clientConfig?.runtime?.allowLocalVm }),
    [clientConfig?.runtime?.allowLocalVm],
  );
  const createTask = useAction(convexApi.executor.createTask);
  const { tools, typesUrl, loadingTools } = useWorkspaceTools(context ?? null);
  const effectiveRuntimeId = runtimeTargets.some((runtime: RuntimeTargetDescriptor) => runtime.id === runtimeId)
    ? runtimeId
    : runtimeTargets[0]?.id ?? "";
  const selectedRuntime = runtimeTargets.find((runtime) => runtime.id === effectiveRuntimeId);
  const showRuntimeSelector = runtimeTargets.length > 1;

  useEffect(() => {
    const draft = readCodeDraftForWorkspace(storageWorkspaceId);
    if (draft !== null) {
      setCode(draft);
    }
  }, [codeDraftStorageKey]);

  const handleCodeChange = (nextCode: string) => {
    setCode(nextCode);
    writeWorkspaceCodeDraft(storageWorkspaceId, nextCode);
  };

  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  useEffect(() => {
    const flushCodeDraft = () => {
      writeWorkspaceCodeDraft(storageWorkspaceId, codeRef.current);
    };

    if (typeof document === "undefined") {
      return;
    }

    document.addEventListener("visibilitychange", flushCodeDraft);
    window.addEventListener("pagehide", flushCodeDraft);

    return () => {
      document.removeEventListener("visibilitychange", flushCodeDraft);
      window.removeEventListener("pagehide", flushCodeDraft);
      flushCodeDraft();
    };
  }, [codeDraftStorageKey]);

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
            {showRuntimeSelector ? <Label className="text-xs text-muted-foreground">Runtime</Label> : null}
            {showRuntimeSelector ? (
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
            ) : (
             null
            )}
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
              onChange={handleCodeChange}
              tools={tools}
              typesUrl={typesUrl}
              stateStorageKey={editorViewStateStorageKey}
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
                  className="min-h-40 max-h-[65vh] overflow-auto resize-y"
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
                  className="min-h-32 max-h-[50vh] overflow-auto resize-y"
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

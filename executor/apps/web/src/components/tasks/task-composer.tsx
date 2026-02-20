"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import { useAction } from "convex/react";
import { toast } from "sonner";
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
  const showRuntimeSelector = runtimeTargets.length > 1;
  const isMac = useMemo(() => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent), []);
  const modKey = isMac ? "⌘" : "Ctrl";

  useEffect(() => {
    const draft = readCodeDraftForWorkspace(storageWorkspaceId);
    if (draft !== null) {
      setCode(draft);
    }
  }, [codeDraftStorageKey, storageWorkspaceId]);

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
  }, [codeDraftStorageKey, storageWorkspaceId]);

  const handleSubmitRef = useRef<(() => void) | undefined>(undefined);

  const handleSubmit = useCallback(async () => {
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
  }, [context, code, effectiveRuntimeId, timeoutMs, createTask]);

  handleSubmitRef.current = handleSubmit;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmitRef.current?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* ── Toolbar ── */}
      <div className="shrink-0 flex items-center justify-between gap-3 border-b border-border/40 px-4 py-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium">Editor</h3>
          <span className="text-[10px] font-mono text-muted-foreground">
            {loadingTools
              ? "Loading tool inventory..."
              : `${tools.length} tool${tools.length === 1 ? "" : "s"} loaded${typesUrl ? ", type defs ready" : ""}`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {showRuntimeSelector ? (
            <Select value={effectiveRuntimeId} onValueChange={setRuntimeId}>
              <SelectTrigger className="h-7 text-xs font-mono bg-background w-[160px]">
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
          ) : null}
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] text-muted-foreground shrink-0">Timeout</Label>
            <Input
              type="number"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              className="h-7 text-xs font-mono bg-background w-[100px]"
            />
          </div>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !code.trim()}
            className="h-7 bg-primary text-primary-foreground hover:bg-primary/90 text-xs gap-1.5 px-3"
            size="sm"
          >
            <Send className="h-3 w-3" />
            {submitting ? "Executing..." : "Execute"}
            <kbd className="ml-1 pointer-events-none inline-flex items-center gap-0.5 rounded border border-primary-foreground/20 bg-primary-foreground/10 px-1 py-0.5 font-mono text-[10px] font-medium text-primary-foreground/70">
              {modKey}↵
            </kbd>
          </Button>
        </div>
      </div>

      {/* ── Main content area ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Code editor - fills available space */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col" style={{ borderRight: lastExecution ? '1px solid hsl(var(--border) / 0.4)' : undefined }}>
          <CodeEditor
            value={code}
            onChange={handleCodeChange}
            tools={tools}
            typesUrl={typesUrl}
            stateStorageKey={editorViewStateStorageKey}
            className="h-full"
            height="100%"
          />
        </div>

        {/* Result panel - right side */}
        {lastExecution && (
          <div className="w-[400px] lg:w-[480px] shrink-0 flex flex-col min-h-0 overflow-hidden">
            <div className="shrink-0 flex items-center justify-between gap-2 border-b border-border/30 px-3 py-2">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Last execution
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {lastExecution.status} - {lastExecution.taskId}
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
              {lastExecution.result !== undefined && (
                <div>
                  <span className="text-[10px] uppercase tracking-widest text-terminal-green block mb-2">
                    Returned result
                  </span>
                  <FormattedCodeBlock
                    content={lastExecution.result}
                    language="json"
                    className="min-h-40 max-h-full overflow-auto resize-y"
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
                    className="min-h-32 max-h-full overflow-auto resize-y"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

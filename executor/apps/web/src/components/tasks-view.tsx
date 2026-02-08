"use client";

import { useState, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Play,
  ChevronRight,
  X,
  Send,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CodeEditor } from "@/components/code-editor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import { TaskStatusBadge } from "@/components/status-badge";
import { useSession } from "@/lib/session-context";
import { useWorkspaceTools } from "@/hooks/use-workspace-tools";
import { useMutation, useQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import type {
  TaskRecord,
} from "@/lib/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const DEFAULT_CODE = `// Example: call some tools
const time = await tools.utils.get_time();
console.log("Current time:", time.iso);

const result = await tools.math.add({ a: 7, b: 35 });
console.log("7 + 35 =", result.result);

// This will require approval:
await tools.admin.send_announcement({
  channel: "general",
  message: "Hello from executor!"
});`;

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Task Composer ──

function TaskComposer() {
  const { context } = useSession();
  const [code, setCode] = useState(DEFAULT_CODE);
  const [runtimeId, setRuntimeId] = useState("local-bun");
  const [timeoutMs, setTimeoutMs] = useState("15000");
  const [submitting, setSubmitting] = useState(false);
  const createTask = useMutation(convexApi.database.createTask);

  const runtimes = useQuery(convexApi.database.listRuntimeTargets, {});
  const { tools } = useWorkspaceTools(context ?? null);

  const handleSubmit = async () => {
    if (!context || !code.trim()) return;
    setSubmitting(true);
    try {
      const task = await createTask({
        id: `task_${crypto.randomUUID()}`,
        code,
        runtimeId,
        timeoutMs: parseInt(timeoutMs) || 15000,
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        clientId: context.clientId,
      });
      toast.success(`Task created: ${task.id}`);
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
                {(runtimes ?? []).map((r) => (
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
          <Label className="text-xs text-muted-foreground">Code</Label>
          <div className="rounded-md border border-border overflow-hidden">
            <CodeEditor
              value={code}
              onChange={setCode}
              tools={tools ?? []}
              height="240px"
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

// ── Task List ──

function TaskListItem({
  task,
  selected,
  onClick,
}: {
  task: TaskRecord;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors text-left group",
        selected
          ? "bg-primary/10 border border-primary/20"
          : "hover:bg-accent/50 border border-transparent",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-foreground truncate">
            {task.id}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] font-mono text-muted-foreground">
            {task.runtimeId}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {formatDate(task.createdAt)}
          </span>
        </div>
      </div>
      <TaskStatusBadge status={task.status} />
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}

// ── Task Detail ──

function TaskDetail({
  task,
  workspaceId,
  onClose,
}: {
  task: TaskRecord;
  workspaceId: string;
  onClose: () => void;
}) {
  const liveTaskData = useQuery(
    convexApi.database.getTaskInWorkspace,
    workspaceId ? { taskId: task.id, workspaceId } : "skip",
  );
  const taskEvents = useQuery(
    convexApi.database.listTaskEvents,
    workspaceId ? { taskId: task.id } : "skip",
  );

  const liveTask = liveTaskData ?? task;
  const liveStdout = useMemo(() => {
    const stdoutLines = (taskEvents ?? [])
      .filter((event) => event.type === "task.stdout")
      .map((event) => String((event.payload as Record<string, unknown>)?.line ?? ""));
    if (stdoutLines.length > 0) {
      return stdoutLines.join("\n");
    }
    return liveTask.stdout ?? "";
  }, [taskEvents, liveTask.stdout]);

  const liveStderr = useMemo(() => {
    const stderrLines = (taskEvents ?? [])
      .filter((event) => event.type === "task.stderr")
      .map((event) => String((event.payload as Record<string, unknown>)?.line ?? ""));
    if (stderrLines.length > 0) {
      return stderrLines.join("\n");
    }
    return liveTask.stderr ?? "";
  }, [taskEvents, liveTask.stderr]);

  const duration =
    liveTask.completedAt && liveTask.startedAt
      ? `${((liveTask.completedAt - liveTask.startedAt) / 1000).toFixed(2)}s`
      : liveTask.startedAt
        ? "running..."
        : "—";

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium font-mono truncate pr-4">
            {liveTask.id}
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Metadata grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Status", value: <TaskStatusBadge status={liveTask.status} /> },
            { label: "Runtime", value: <span className="font-mono text-xs">{liveTask.runtimeId}</span> },
            { label: "Duration", value: <span className="font-mono text-xs">{duration}</span> },
            {
              label: "Exit Code",
              value: (
                <span className={cn("font-mono text-xs", liveTask.exitCode === 0 ? "text-terminal-green" : liveTask.exitCode ? "text-terminal-red" : "text-muted-foreground")}>
                  {liveTask.exitCode ?? "—"}
                </span>
              ),
            },
          ].map((item) => (
            <div key={item.label}>
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground block mb-1">
                {item.label}
              </span>
              {item.value}
            </div>
          ))}
        </div>

        <Separator />

        {/* Code */}
        <div>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground block mb-2">
            Code
          </span>
          <pre className="terminal-block max-h-48 overflow-y-auto">
            {liveTask.code}
          </pre>
        </div>

        {/* Stdout */}
        {liveStdout && (
          <div>
            <span className="text-[10px] uppercase tracking-widest text-terminal-green block mb-2">
              Stdout
            </span>
            <pre className="terminal-block max-h-48 overflow-y-auto text-terminal-green/80">
              {liveStdout}
            </pre>
          </div>
        )}

        {/* Stderr */}
        {liveStderr && (
          <div>
            <span className="text-[10px] uppercase tracking-widest text-terminal-amber block mb-2">
              Stderr
            </span>
            <pre className="terminal-block max-h-48 overflow-y-auto text-terminal-amber/80">
              {liveStderr}
            </pre>
          </div>
        )}

        {/* Error */}
        {liveTask.error && (
          <div>
            <span className="text-[10px] uppercase tracking-widest text-terminal-red block mb-2">
              Error
            </span>
            <pre className="terminal-block max-h-48 overflow-y-auto text-terminal-red/80">
              {liveTask.error}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Tasks View ──

export function TasksView() {
  const { context, loading: sessionLoading } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("selected");

  const tasks = useQuery(
    convexApi.database.listTasks,
    context ? { workspaceId: context.workspaceId } : "skip",
  );
  const tasksLoading = !!context && tasks === undefined;

  const selectedTask = tasks?.find((t) => t.id === selectedId);

  const selectTask = useCallback(
    (taskId: string | null) => {
      if (taskId) {
        router.push(`/tasks?selected=${taskId}`, { scroll: false });
      } else {
        router.push("/tasks", { scroll: false });
      }
    },
    [router],
  );

  if (sessionLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description="Execute code and manage task history"
      />

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Left: composer + list */}
        <div className="space-y-6">
          <TaskComposer />

          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                Task History
                {tasks && (
                  <span className="text-[10px] font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                    {tasks.length}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {tasksLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-14" />
                  ))}
                </div>
              ) : !tasks || tasks.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                  No tasks yet. Create one above.
                </div>
              ) : (
                <div className="space-y-1 max-h-[500px] overflow-y-auto">
                  {tasks.map((task) => (
                    <TaskListItem
                      key={task.id}
                      task={task}
                      selected={task.id === selectedId}
                      onClick={() => selectTask(task.id)}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: detail panel */}
        <div>
          {selectedTask ? (
            <TaskDetail
              task={selectedTask}
              workspaceId={context!.workspaceId}
              onClose={() => selectTask(null)}
            />
          ) : (
            <Card className="bg-card border-border">
              <CardContent className="flex items-center justify-center py-24">
                <p className="text-sm text-muted-foreground">
                  Select a task to view details
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

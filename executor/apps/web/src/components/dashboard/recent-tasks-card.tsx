import { useNavigate } from "react-router";
import { Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TaskStatusBadge } from "@/components/status-badge";
import type { TaskRecord } from "@/lib/types";
import { formatTime } from "@/lib/format";

function RecentTaskRow({ task }: { task: TaskRecord }) {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate("/tools?tab=editor")}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-accent/50 transition-colors text-left group"
    >
      <div className="flex-1 min-w-0">
        <span className="text-sm font-mono text-foreground truncate block">{task.id}</span>
        <span className="text-[11px] text-muted-foreground">
          {task.runtimeId} &middot; {formatTime(task.createdAt)}
        </span>
      </div>
      <TaskStatusBadge status={task.status} />
    </button>
  );
}

export function DashboardRecentTasksCard({ recentTasks }: { recentTasks: TaskRecord[] }) {
  const navigate = useNavigate();

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Recent Tasks
          </CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs h-7"
            onClick={() => navigate("/tools?tab=editor")}
          >
            Open editor
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {recentTasks.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            No tasks yet
          </div>
        ) : (
          <div className="space-y-0.5">
            {recentTasks.map((task) => (
              <RecentTaskRow key={task.id} task={task} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

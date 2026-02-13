import type { PendingApprovalRecord, TaskRecord, ToolDescriptor } from "@/lib/types";
import { sourceLabel, sourceType } from "@/lib/tool-source-utils";

type SetupStep = {
  label: string;
  done: boolean;
  href: string;
  pendingText: string;
  doneText: string;
};

export type DashboardTaskStats = {
  runningCount: number;
  completedCount: number;
  failedCount: number;
};

export type ToolSourceGroup = {
  name: string;
  type: string;
  tools: ToolDescriptor[];
  namespaces: Set<string>;
  approvalCount: number;
};

export function getTaskStats(tasks: TaskRecord[]): DashboardTaskStats {
  return {
    runningCount: tasks.filter((task) => task.status === "running").length,
    completedCount: tasks.filter((task) => task.status === "completed").length,
    failedCount: tasks.filter((task) => ["failed", "timed_out", "denied"].includes(task.status)).length,
  };
}

export function getSetupSteps({
  sourceCount,
  taskCount,
  pendingCount,
}: {
  sourceCount: number;
  taskCount: number;
  pendingCount: number;
}): SetupStep[] {
  return [
    {
      label: "Connect a tool source",
      done: sourceCount > 0,
      href: "/tools",
      pendingText: "Add MCP, OpenAPI, or GraphQL",
      doneText: `${sourceCount} source${sourceCount === 1 ? "" : "s"} connected`,
    },
    {
      label: "Run a first task",
      done: taskCount > 0,
      href: "/tools?tab=editor",
      pendingText: "Use the editor to execute code",
      doneText: `${taskCount} task${taskCount === 1 ? "" : "s"} recorded`,
    },
    {
      label: "Review gated calls",
      done: pendingCount === 0,
      href: "/approvals",
      pendingText: `${pendingCount} approval${pendingCount === 1 ? "" : "s"} waiting`,
      doneText: "Approval queue is clear",
    },
  ];
}

export function getRecentTasks(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.slice(0, 8);
}

export function getPendingApprovals(approvals: PendingApprovalRecord[]): PendingApprovalRecord[] {
  return approvals.slice(0, 5);
}

export function groupToolsBySource(tools: ToolDescriptor[]): ToolSourceGroup[] {
  const map = new Map<string, ToolSourceGroup>();

  for (const tool of tools) {
    const name = sourceLabel(tool.source);
    const type = sourceType(tool.source);
    let group = map.get(name);
    if (!group) {
      group = { name, type, tools: [], namespaces: new Set(), approvalCount: 0 };
      map.set(name, group);
    }

    group.tools.push(tool);

    const parts = tool.path.split(".");
    if (parts.length >= 2) {
      group.namespaces.add(`${parts[0]}.${parts[1]}`);
    }

    if (tool.approval === "required") {
      group.approvalCount++;
    }
  }

  return Array.from(map.values()).sort((a, b) => b.tools.length - a.tools.length);
}

import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { TasksView } from "@/components/tasks/tasks-view";

export const Route = createFileRoute("/tasks")({
  component: TasksPage,
});

function TasksPage() {
  return (
    <AppShell>
      <TasksView />
    </AppShell>
  );
}

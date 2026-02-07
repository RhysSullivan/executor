import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { TasksView } from "@/components/tasks-view";

export default function TasksPage() {
  return (
    <AppShell>
      <Suspense>
        <TasksView />
      </Suspense>
    </AppShell>
  );
}

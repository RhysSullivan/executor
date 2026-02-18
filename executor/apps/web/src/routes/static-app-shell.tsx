import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { DashboardView } from "@/components/dashboard/view";

export const Route = createFileRoute("/static-app-shell")({
  component: StaticAppShellPage,
});

function StaticAppShellPage() {
  return (
    <AppShell>
      <DashboardView />
    </AppShell>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { ApprovalsView } from "@/components/approvals/approvals-view";

export const Route = createFileRoute("/approvals")({
  component: ApprovalsPage,
});

function ApprovalsPage() {
  return (
    <AppShell>
      <ApprovalsView />
    </AppShell>
  );
}

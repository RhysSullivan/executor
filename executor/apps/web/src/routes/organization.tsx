import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { OrganizationSettingsView } from "@/components/organization/organization/settings-view";

export const Route = createFileRoute("/organization")({
  component: OrganizationPage,
});

function OrganizationPage() {
  return (
    <AppShell>
      <OrganizationSettingsView />
    </AppShell>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { OnboardingView } from "@/components/organization/onboarding-view";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  return (
    <AppShell>
      <OnboardingView />
    </AppShell>
  );
}

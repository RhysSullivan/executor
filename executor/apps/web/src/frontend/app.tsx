"use client";

import { Navigate, Outlet, Route, Routes, BrowserRouter, useSearchParams } from "react-router";
import { AppShell } from "@/components/app-shell";
import { ApprovalsView } from "@/components/approvals-view";
import { DashboardView } from "@/components/dashboard-view";
import { OnboardingView } from "@/components/onboarding-view";
import { OrganizationSettingsView } from "@/components/organization-settings-view";
import { TasksView } from "@/components/tasks-view";
import { ToolsView } from "@/components/tools-view";

function ToolsRoute() {
  const [searchParams] = useSearchParams();
  const source = searchParams.get("source");

  return (
    <div className="h-full min-h-0">
      <ToolsView initialSource={source} />
    </div>
  );
}

function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export default function FrontendApp() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<ShellLayout />}>
          <Route path="/" element={<DashboardView />} />
          <Route path="/static-app-shell" element={<DashboardView />} />
          <Route path="/tasks" element={<TasksView />} />
          <Route path="/approvals" element={<ApprovalsView />} />
          <Route path="/tools" element={<ToolsRoute />} />
          <Route path="/organization" element={<OrganizationSettingsView />} />
          <Route path="/onboarding" element={<OnboardingView />} />
          <Route path="/members" element={<Navigate to="/organization?tab=members" replace />} />
          <Route path="/billing" element={<Navigate to="/organization?tab=billing" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

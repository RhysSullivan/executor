"use client";

import { Navigate, Outlet, Route, Routes, BrowserRouter, useSearchParams } from "react-router";
import { AppShell } from "@/components/app-shell";
import { ApprovalsView } from "@/components/approvals/approvals-view";
import { DashboardView } from "@/components/dashboard/view";
import { MenubarMvpView } from "@/components/menubar/mvp-view";
import { OnboardingView } from "@/components/organization/onboarding-view";
import { OrganizationSettingsView } from "@/components/organization/organization-settings-view";
import { TasksView } from "@/components/tasks/tasks-view";
import { ToolsView } from "@/components/tools/view";

function ToolsRoute() {
  const [searchParams] = useSearchParams();
  const source = searchParams.get("source");
  const tab = searchParams.get("tab");

  return (
    <div className="h-full min-h-0">
      <ToolsView key={`${tab ?? "catalog"}:${source ?? "all"}`} initialSource={source} initialTab={tab} />
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
        <Route path="/menubar" element={<MenubarMvpView />} />
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

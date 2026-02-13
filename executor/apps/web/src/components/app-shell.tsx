"use client";

import { Suspense, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ExternalLink, Github, LayoutDashboard, ListTodo, ShieldCheck, Wrench, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { useSession } from "@/lib/session-context";
import { ApprovalNotifier } from "@/components/approval-notifier";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { WorkspaceSelector } from "@/components/workspace-selector";
import { SessionInfo } from "@/components/session-info";
import { NoOrganizationModal } from "@/components/no-organization-modal";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/tools", label: "Tools", icon: Wrench },
];

const EXECUTOR_REPO_URL = "https://github.com/RhysSullivan/executor";

function NavLinks({ onClick }: { onClick?: () => void }) {
  const location = useLocation();
  const pathname = location.pathname;

  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            to={item.href}
            onClick={onClick}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors",
              isActive
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent",
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function RepoStarLink() {
  return (
    <a
      href={EXECUTOR_REPO_URL}
      target="_blank"
      rel="noreferrer"
      className="group flex items-center justify-between px-1 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
    >
      <span className="flex items-center gap-1.5">
        <Github className="h-3.5 w-3.5" />
        Star Executor
      </span>
      <ExternalLink className="h-3.5 w-3.5 opacity-70 transition-opacity group-hover:opacity-100" />
    </a>
  );
}

function Sidebar() {
  return (
    <aside className="hidden md:flex md:w-56 lg:w-60 flex-col border-r border-border bg-sidebar h-screen sticky top-0">
      <div className="h-14 border-b border-border shrink-0">
        <WorkspaceSelector inHeader />
      </div>
      <div className="flex-1 overflow-y-auto py-4 px-2">
        <NavLinks />
      </div>
      <div className="pb-1">
        <Suspense>
          <SessionInfo />
        </Suspense>
      </div>
      <div className="px-3 pb-1">
        <RepoStarLink />
      </div>
      <div className="px-3 pb-2 pt-1">
        <ThemeSwitcher />
      </div>
    </aside>
  );
}

function MobileHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="md:hidden flex items-center justify-between h-14 pr-2 border-b border-border bg-sidebar sticky top-0 z-50">
      <div className="flex-1 min-w-0 h-full">
        <WorkspaceSelector inHeader />
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="h-14 border-b border-border">
            <WorkspaceSelector inHeader />
          </div>
          <div className="py-4 px-2">
            <NavLinks onClick={() => setOpen(false)} />
          </div>
          <div className="mt-auto pb-1">
            <Suspense>
              <SessionInfo />
            </Suspense>
          </div>
          <div className="px-3 pb-1">
            <RepoStarLink />
          </div>
          <div className="px-3 pb-3 pt-1">
            <ThemeSwitcher />
          </div>
        </SheetContent>
      </Sheet>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const pathname = location.pathname;
  const navigate = useNavigate();
  const { loading, organizations, organizationsLoading, isSignedInToWorkos } = useSession();

  const onOnboardingRoute = pathname.startsWith("/onboarding");
  const needsOnboarding = isSignedInToWorkos && !organizationsLoading && organizations.length === 0;

  useEffect(() => {
    if (loading || organizationsLoading) {
      return;
    }

    if (needsOnboarding && !onOnboardingRoute) {
      navigate("/onboarding", { replace: true });
      return;
    }

    if (!needsOnboarding && onOnboardingRoute && organizations.length > 0) {
      navigate("/", { replace: true });
    }
  }, [
    loading,
    organizationsLoading,
    needsOnboarding,
    onOnboardingRoute,
    organizations.length,
    navigate,
  ]);

  if (isSignedInToWorkos && organizationsLoading && !onOnboardingRoute) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Loading organization...</p>
      </div>
    );
  }

  if (onOnboardingRoute || needsOnboarding) {
    return (
      <div className="min-h-screen bg-background">
        <main className="mx-auto w-full max-w-2xl p-4 md:p-8">{children}</main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <ApprovalNotifier />
      <NoOrganizationModal enabled />
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <MobileHeader />
        <main className="flex-1 min-h-0 p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}

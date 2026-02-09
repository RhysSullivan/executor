"use client";

import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "convex/react";
import {
  LayoutDashboard,
  Play,
  ShieldCheck,
  Wrench,
  Menu,
  X,
  ChevronsUpDown,
  Plus,
  Check,
  Settings,
  LogIn,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import { workosEnabled } from "@/lib/auth-capabilities";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tasks", label: "Tasks", icon: Play },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/tools", label: "Tools", icon: Wrench },
];

function NavLinks({ onClick }: { onClick?: () => void }) {
  const pathname = usePathname();

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
            href={item.href}
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

function WorkspaceSelector({ inHeader = false }: { inHeader?: boolean }) {
  const router = useRouter();
  const createOrganizationMutation = useMutation(convexApi.organizations.create);
  const {
    context,
    mode,
    clientConfig,
    workspaces,
    switchWorkspace,
    creatingWorkspace,
    createWorkspace,
  } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceIcon, setNewWorkspaceIcon] = useState<File | null>(null);
  const [createScope, setCreateScope] = useState<"current_org" | "new_org">("current_org");
  const [createTargetOrganizationId, setCreateTargetOrganizationId] = useState<(typeof workspaces)[number]["organizationId"]>(null);
  const [createTargetOrganizationName, setCreateTargetOrganizationName] = useState<string | null>(null);
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const activeWorkspace = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId)
    : null;
  const activeOrganizationLabel = activeWorkspace?.organizationName ?? "Organization";
  const activeWorkspaceLabel = activeWorkspace?.name ?? (mode === "guest" ? "Guest Workspace" : "Select workspace");
  const activeWorkspaceInitial = (activeWorkspaceLabel[0] ?? "W").toUpperCase();

  const workspaceGroups = useMemo(() => {
    if (mode !== "workos") {
      return [];
    }

    const groups: Array<{
      key: string;
      organizationId: (typeof workspaces)[number]["organizationId"];
      organizationName: string;
      workspaces: Array<(typeof workspaces)[number]>;
    }> = [];
    const byKey = new Map<string, number>();

    for (const workspace of workspaces) {
      const key = workspace.organizationId ? `org:${workspace.organizationId}` : `workspace:${workspace.id}`;
      const existingIndex = byKey.get(key);
      if (existingIndex === undefined) {
        byKey.set(key, groups.length);
        groups.push({
          key,
          organizationId: workspace.organizationId,
          organizationName: workspace.organizationName ?? "Organization",
          workspaces: [workspace],
        });
        continue;
      }

      groups[existingIndex].workspaces.push(workspace);
    }

    return groups;
  }, [mode, workspaces]);

  const openCreateWorkspaceForOrganization = (
    organizationId: (typeof workspaces)[number]["organizationId"],
    organizationName: string,
  ) => {
    setCreateError(null);
    setNewWorkspaceName("");
    setNewWorkspaceIcon(null);
    setCreateScope("current_org");
    setCreateTargetOrganizationId(organizationId);
    setCreateTargetOrganizationName(organizationName);
    setCreateOpen(true);
  };

  const openCreateOrganization = () => {
    setCreateError(null);
    setNewWorkspaceName("");
    setNewWorkspaceIcon(null);
    setCreateScope("new_org");
    setCreateTargetOrganizationId(null);
    setCreateTargetOrganizationName(null);
    setCreateOpen(true);
  };

  const handleCreateWorkspace = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

    const trimmed = newWorkspaceName.trim();
    if (trimmed.length < 2) {
      setCreateError("Workspace name must be at least 2 characters.");
      return;
    }

    try {
      if (createScope === "new_org") {
        setCreatingOrganization(true);
        const created = await createOrganizationMutation({ name: trimmed });
        switchWorkspace(created.workspace.id);
      } else {
        if (!createTargetOrganizationId) {
          throw new Error("Select an organization first");
        }

        await createWorkspace(trimmed, newWorkspaceIcon, createTargetOrganizationId);
      }

      setCreateError(null);
      setNewWorkspaceName("");
      setNewWorkspaceIcon(null);
      setCreateOpen(false);
    } catch (cause) {
      const fallback = createScope === "new_org" ? "Failed to create organization" : "Failed to create workspace";
      setCreateError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setCreatingOrganization(false);
    }
  };

  const triggerClassName = inHeader
    ? "h-full w-full justify-between rounded-none border-0 bg-transparent px-3 text-[12px] font-medium shadow-none hover:bg-accent/40"
    : "h-8 w-full justify-between text-[11px]";
  const isCreating = creatingWorkspace || creatingOrganization;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={inHeader ? "ghost" : "outline"}
            size="sm"
            className={triggerClassName}
          >
            <span className="flex items-center gap-2 min-w-0">
              {activeWorkspace?.iconUrl ? (
                <img
                  src={activeWorkspace.iconUrl}
                  alt={activeWorkspaceLabel}
                  className="h-4 w-4 rounded-sm border border-border object-cover"
                />
              ) : (
                <span className="h-4 w-4 rounded-sm border border-border bg-muted text-[9px] font-semibold flex items-center justify-center text-muted-foreground">
                  {activeWorkspaceInitial}
                </span>
              )}
              <span className="min-w-0">
                {mode === "workos" ? (
                  <>
                    <span className="truncate block text-[10px] text-muted-foreground">{activeOrganizationLabel}</span>
                    <span className="truncate block">{activeWorkspaceLabel}</span>
                  </>
                ) : (
                  <span className="truncate block">{activeWorkspaceLabel}</span>
                )}
              </span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {mode === "workos"
            ? (
              <>
                {workspaceGroups.map((group, groupIndex) => {
                  const settingsWorkspace = group.workspaces.find((workspace) => workspace.id === context?.workspaceId)
                    ?? group.workspaces[0]
                    ?? null;

                  return (
                    <div key={group.key}>
                      {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
                      <div className="px-2 py-1.5 flex items-center justify-between gap-2">
                        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground truncate">
                          {group.organizationName}
                        </span>
                        {settingsWorkspace ? (
                          <button
                            type="button"
                            className="inline-flex h-5 w-5 items-center justify-center rounded-sm border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                            onClick={() => {
                              switchWorkspace(settingsWorkspace.id);
                              router.push("/organization?tab=members");
                            }}
                            aria-label={`Open ${group.organizationName} settings`}
                            title="Organization settings"
                          >
                            <Settings className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                      {group.workspaces.map((workspace) => {
                        const isActive = workspace.id === context?.workspaceId;
                        return (
                          <DropdownMenuItem
                            key={workspace.id}
                            onSelect={() => switchWorkspace(workspace.id)}
                            className="text-xs"
                          >
                            <Check className={cn("mr-2 h-3.5 w-3.5", isActive ? "opacity-100" : "opacity-0")} />
                            {workspace.iconUrl ? (
                              <img
                                src={workspace.iconUrl}
                                alt={workspace.name}
                                className="mr-2 h-4 w-4 rounded-sm border border-border object-cover"
                              />
                            ) : (
                              <span className="mr-2 h-4 w-4 rounded-sm border border-border bg-muted text-[9px] font-semibold flex items-center justify-center text-muted-foreground">
                                {(workspace.name[0] ?? "W").toUpperCase()}
                              </span>
                            )}
                            <span className="min-w-0 truncate">{workspace.name}</span>
                          </DropdownMenuItem>
                        );
                      })}

                      {group.organizationId ? (
                        <DropdownMenuItem
                          onSelect={() => openCreateWorkspaceForOrganization(group.organizationId, group.organizationName)}
                          className="text-xs"
                        >
                          <Plus className="mr-2 h-3.5 w-3.5" />
                          New workspace
                        </DropdownMenuItem>
                      ) : null}
                    </div>
                  );
                })}

                {workspaces.length === 0 ? (
                  <DropdownMenuItem disabled className="text-xs">
                    No workspaces
                  </DropdownMenuItem>
                ) : null}
              </>
            )
            : (
              <DropdownMenuItem disabled className="text-xs">
                Guest workspace
              </DropdownMenuItem>
            )}
          {mode === "workos" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openCreateOrganization} className="text-xs">
                <Plus className="mr-2 h-3.5 w-3.5" />
                New organization
              </DropdownMenuItem>

            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <form className="space-y-4" onSubmit={handleCreateWorkspace}>
            <DialogHeader>
              <DialogTitle>{createScope === "new_org" ? "Create organization" : "Create workspace"}</DialogTitle>
              <DialogDescription>
                {createScope === "new_org"
                  ? "Create a new organization with a default workspace."
                  : `Create a workspace inside ${createTargetOrganizationName ?? "this organization"}.`}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Input
                value={newWorkspaceName}
                onChange={(event) => {
                  setCreateError(null);
                  setNewWorkspaceName(event.target.value);
                }}
                placeholder={createScope === "new_org" ? "Acme" : "Marketing"}
                maxLength={64}
              />
              {createScope === "current_org" ? (
                <>
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      setCreateError(null);
                      setNewWorkspaceIcon(event.target.files?.[0] ?? null);
                    }}
                  />
                  {newWorkspaceIcon ? (
                    <p className="text-[11px] text-muted-foreground truncate">
                      Icon: {newWorkspaceIcon.name}
                    </p>
                  ) : null}
                </>
              ) : null}
              {createError ? (
                <p className="text-xs text-destructive">{createError}</p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isCreating}>
                {isCreating
                  ? "Creating..."
                  : createScope === "new_org"
                    ? "Create organization"
                    : "Create workspace"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SessionInfo() {
  const { loading, clientConfig, isSignedInToWorkos, workosProfile, context, workspaces } = useSession();
  const searchParams = useSearchParams();
  const avatarUrl = workosProfile?.avatarUrl ?? null;
  const avatarLabel = workosProfile?.name || workosProfile?.email || "User";
  const avatarInitial = (avatarLabel[0] ?? "U").toUpperCase();

  const activeWorkspace = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId)
    : null;
  const inferredOrganizationId = activeWorkspace?.organizationId ?? undefined;
  const hintedOrganizationId =
    searchParams.get("organization_id")
    ?? searchParams.get("organizationId")
    ?? searchParams.get("org_id")
    ?? searchParams.get("orgId")
    ?? inferredOrganizationId
    ?? undefined;
  const hintedLogin =
    searchParams.get("login_hint")
    ?? searchParams.get("loginHint")
    ?? searchParams.get("email")
    ?? undefined;
  const signInParams = new URLSearchParams();
  if (hintedOrganizationId) {
    signInParams.set("organization_id", hintedOrganizationId);
  }
  if (hintedLogin) {
    signInParams.set("login_hint", hintedLogin);
  }
  const signInHref = signInParams.size > 0 ? `/sign-in?${signInParams.toString()}` : "/sign-in";

  if (loading) {
    return (
      <div className="border-t border-border px-3 py-2">
        <span className="text-[11px] font-mono text-muted-foreground">Loading session...</span>
      </div>
    );
  }

  return (
    <div className="border-t border-border">
        {isSignedInToWorkos ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="h-14 w-full justify-between rounded-none border-0 bg-transparent px-3 py-0 text-left shadow-none hover:bg-accent/40"
              >
                <span className="flex items-center gap-2 min-w-0">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={avatarLabel}
                      className="h-6 w-6 rounded-full border border-border object-cover"
                    />
                  ) : (
                    <span className="h-6 w-6 rounded-full border border-border bg-muted text-[10px] font-mono text-muted-foreground flex items-center justify-center">
                      {avatarInitial}
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="text-[11px] font-medium truncate block">{avatarLabel}</span>
                    {workosProfile?.email ? (
                      <span className="text-[10px] text-muted-foreground truncate block">{workosProfile.email}</span>
                    ) : null}
                  </span>
                </span>
                <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-xs">
                Account
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild className="text-xs">
                <Link href="/sign-out">Sign out</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="px-3 py-3 space-y-2">
            {workosEnabled ? (
              <Link href={signInHref} className="block">
                <Button
                  variant="outline"
                  className="w-full h-9 justify-center gap-2 text-xs font-medium"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  Sign in
                </Button>
              </Link>
            ) : (
              <p className="text-[11px] text-muted-foreground text-center">Guest mode</p>
            )}
          </div>
        )}

    </div>
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
      <div className="px-3 py-2">
        <ThemeSwitcher />
      </div>
      <div className="pb-4">
        <Suspense>
          <SessionInfo />
        </Suspense>
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
          <div className="px-3 py-2">
            <ThemeSwitcher />
          </div>
          <div className="mt-auto pb-4">
            <Suspense>
              <SessionInfo />
            </Suspense>
          </div>
        </SheetContent>
      </Sheet>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { loading, organizations, organizationsLoading, isSignedInToWorkos } = useSession();

  const onOnboardingRoute = pathname.startsWith("/onboarding");
  const needsOnboarding = isSignedInToWorkos && !organizationsLoading && organizations.length === 0;

  useEffect(() => {
    if (loading || organizationsLoading) {
      return;
    }

    if (needsOnboarding && !onOnboardingRoute) {
      router.replace("/onboarding");
      return;
    }

    if (!needsOnboarding && onOnboardingRoute && organizations.length > 0) {
      router.replace("/");
    }
  }, [
    loading,
    organizationsLoading,
    needsOnboarding,
    onOnboardingRoute,
    organizations.length,
    router,
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
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <MobileHeader />
        <main className="flex-1 p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}

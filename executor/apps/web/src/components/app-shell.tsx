"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
import { workosEnabled } from "@/lib/auth-capabilities";
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
  const { context, mode, workspaces, switchWorkspace, creatingWorkspace, createWorkspace } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceIcon, setNewWorkspaceIcon] = useState<File | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const activeWorkspace = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId)
    : null;
  const activeWorkspaceLabel = activeWorkspace?.name ?? (mode === "guest" ? "Guest Workspace" : "Select workspace");
  const activeWorkspaceInitial = (activeWorkspaceLabel[0] ?? "W").toUpperCase();

  const openCreateWorkspace = () => {
    setCreateError(null);
    setNewWorkspaceName("");
    setNewWorkspaceIcon(null);
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
      await createWorkspace(trimmed, newWorkspaceIcon);
      setCreateError(null);
      setNewWorkspaceName("");
      setNewWorkspaceIcon(null);
      setCreateOpen(false);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Failed to create workspace");
    }
  };

  const triggerClassName = inHeader
    ? "h-full w-full justify-between rounded-none border-0 bg-transparent px-3 text-[12px] font-medium shadow-none hover:bg-accent/40"
    : "h-8 w-full justify-between text-[11px]";

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
              <span className="truncate">{activeWorkspaceLabel}</span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {mode === "workos"
            ? workspaces.map((workspace) => {
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
                    <span className="truncate">{workspace.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {workspace.kind === "organization" ? "Org" : "Hobby"}
                    </span>
                  </DropdownMenuItem>
                );
              })
            : (
              <DropdownMenuItem disabled className="text-xs">
                Guest workspace
              </DropdownMenuItem>
            )}
          {mode === "workos" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openCreateWorkspace} className="text-xs">
                <Plus className="mr-2 h-3.5 w-3.5" />
                New workspace
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <form className="space-y-4" onSubmit={handleCreateWorkspace}>
            <DialogHeader>
              <DialogTitle>Create workspace</DialogTitle>
              <DialogDescription>
                Create a new hobby workspace for your account.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Input
                value={newWorkspaceName}
                onChange={(event) => {
                  setCreateError(null);
                  setNewWorkspaceName(event.target.value);
                }}
                placeholder="Acme Labs"
                maxLength={64}
              />
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
              {createError ? (
                <p className="text-xs text-destructive">{createError}</p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={creatingWorkspace}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creatingWorkspace}>
                {creatingWorkspace ? "Creating..." : "Create workspace"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SessionInfo() {
  const { loading, isSignedInToWorkos, workosProfile } = useSession();
  const avatarUrl = workosProfile?.avatarUrl ?? null;
  const avatarLabel = workosProfile?.name || workosProfile?.email || "User";
  const avatarInitial = (avatarLabel[0] ?? "U").toUpperCase();

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
          <div className="px-3 py-2">
            <p className="text-[11px] text-muted-foreground">Guest mode</p>
          </div>
        )}

        {!isSignedInToWorkos && workosEnabled ? (
          <div className="px-3 pb-3">
            <Link href="/sign-in" className="inline-flex">
              <Button variant="outline" size="sm" className="h-7 text-[11px]">
                Sign in
              </Button>
            </Link>
          </div>
        ) : null}
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
      <div className="pb-4">
        <SessionInfo />
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
          <div className="mt-auto pb-4">
            <SessionInfo />
          </div>
        </SheetContent>
      </Sheet>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
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

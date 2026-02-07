"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Play,
  ShieldCheck,
  Wrench,
  Menu,
  X,
  Terminal,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { useSession } from "@/lib/session-context";
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

function SessionInfo() {
  const { context, loading, resetWorkspace } = useSession();

  if (loading || !context) return null;

  return (
    <div className="px-3 space-y-3">
      <Separator />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Session
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            onClick={resetWorkspace}
            title="Reset workspace"
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-1.5 rounded-full bg-terminal-green pulse-dot" />
            <span className="text-[11px] font-mono text-muted-foreground truncate">
              {context.workspaceId}
            </span>
          </div>
          <span className="text-[11px] font-mono text-muted-foreground/60 block pl-3.5 truncate">
            {context.actorId}
          </span>
        </div>
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="hidden md:flex md:w-56 lg:w-60 flex-col border-r border-border bg-sidebar h-screen sticky top-0">
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border shrink-0">
        <div className="flex items-center justify-center h-7 w-7 rounded bg-primary/15 text-primary">
          <Terminal className="h-4 w-4" />
        </div>
        <span className="font-semibold text-sm tracking-tight">Executor</span>
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
    <header className="md:hidden flex items-center justify-between h-14 px-4 border-b border-border bg-sidebar sticky top-0 z-50">
      <div className="flex items-center gap-2.5">
        <div className="flex items-center justify-center h-7 w-7 rounded bg-primary/15 text-primary">
          <Terminal className="h-4 w-4" />
        </div>
        <span className="font-semibold text-sm tracking-tight">Executor</span>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border">
            <div className="flex items-center justify-center h-7 w-7 rounded bg-primary/15 text-primary">
              <Terminal className="h-4 w-4" />
            </div>
            <span className="font-semibold text-sm tracking-tight">
              Executor
            </span>
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

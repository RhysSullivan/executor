import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useSources, type Source } from "@executor-v3/react";
import { cn } from "../lib/utils";
import { IconSources } from "./icons";
import { LoadableBlock } from "./loadable";

// ── Status dot color ─────────────────────────────────────────────────────

const statusColor: Record<string, string> = {
  connected: "bg-primary",
  probing: "bg-amber-400",
  draft: "bg-muted-foreground/30",
  auth_required: "bg-amber-500",
  error: "bg-destructive",
};

// ── AppShell ─────────────────────────────────────────────────────────────

export function AppShell() {
  const sources = useSources();
  const matchRoute = useMatchRoute();
  const isHome = matchRoute({ to: "/" });

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:w-56">
        {/* Brand */}
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Link to="/" className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">
              executor
            </span>
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              v3
            </span>
          </Link>
        </div>

        {/* Main nav */}
        <nav className="flex flex-1 flex-col p-2 overflow-y-auto">
          <NavItem to="/" label="Dashboard" active={!!isHome} />

          {/* Sources */}
          <div className="mt-5 mb-1 px-2.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/50">
            Sources
          </div>
          <LoadableBlock loadable={sources} loading="Loading...">
            {(items) =>
              items.length === 0 ? (
                <div className="px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground/40">
                  No sources yet
                </div>
              ) : (
                <div className="flex flex-col gap-px">
                  {items.map((source) => (
                    <SourceItem key={source.id} source={source} matchRoute={matchRoute} />
                  ))}
                </div>
              )
            }
          </LoadableBlock>
        </nav>

        {/* Footer */}
        <div className="shrink-0 border-t border-sidebar-border px-4 py-2.5">
          <div className="text-[10px] text-muted-foreground/30">
            Local instance
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

// ── SourceItem ───────────────────────────────────────────────────────────

function SourceItem(props: {
  source: Source;
  matchRoute: ReturnType<typeof useMatchRoute>;
}) {
  const { source, matchRoute } = props;
  const active = matchRoute({
    to: "/sources/$sourceId",
    params: { sourceId: source.id },
    fuzzy: true,
  });

  return (
    <Link
      to="/sources/$sourceId"
      params={{ sourceId: source.id }}
      search={{ tab: "model" }}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
        active
          ? "bg-sidebar-active text-foreground font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
      )}
    >
      <IconSources className="size-3 shrink-0 text-muted-foreground/40" />
      <span className="flex-1 truncate">{source.name}</span>
      <span
        className={cn("size-1.5 shrink-0 rounded-full", statusColor[source.status] ?? "bg-muted-foreground/30")}
        title={source.status}
      />
    </Link>
  );
}

// ── NavItem ──────────────────────────────────────────────────────────────

function NavItem(props: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={props.to}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
        props.active
          ? "bg-sidebar-active text-foreground font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
      )}
    >
      {props.label}
    </Link>
  );
}

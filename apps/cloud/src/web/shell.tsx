import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAtomValue, Result } from "@effect-atom/atom-react";
import { sourcesAtom } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";
import { SourceFavicon } from "@executor/react/components/source-favicon";
import { CommandPalette } from "@executor/react/components/command-palette";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { mcpSourcePlugin } from "@executor/plugin-mcp/react";
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { AUTH_PATHS } from "../auth/api";
import { useAuth } from "./auth";

const sourcePlugins = [
  openApiSourcePlugin,
  mcpSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

// ── NavItem ──────────────────────────────────────────────────────────────

function NavItem(props: { to: string; label: string; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      to={props.to}
      onClick={props.onNavigate}
      className={[
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
        props.active
          ? "bg-sidebar-active text-foreground font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
      ].join(" ")}
    >
      {props.label}
    </Link>
  );
}

// ── SourceList ───────────────────────────────────────────────────────────

function SourceList(props: { pathname: string; onNavigate?: () => void }) {
  const scopeId = useScope();
  const sources = useAtomValue(sourcesAtom(scopeId));

  return Result.match(sources, {
    onInitial: () => (
      <div className="px-2.5 py-2 text-[11px] text-muted-foreground/40">Loading…</div>
    ),
    onFailure: () => (
      <div className="px-2.5 py-2 text-[11px] text-muted-foreground/40">No sources yet</div>
    ),
    onSuccess: ({ value }) =>
      value.length === 0 ? (
        <div className="px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground/40">
          No sources yet
        </div>
      ) : (
        <div className="flex flex-col gap-px">
          {value.map((s) => {
            const detailPath = `/sources/${s.id}`;
            const active =
              props.pathname === detailPath || props.pathname.startsWith(`${detailPath}/`);
            return (
              <Link
                key={s.id}
                to="/sources/$namespace"
                params={{ namespace: s.id }}
                onClick={props.onNavigate}
                className={[
                  "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                  active
                    ? "bg-sidebar-active text-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
                ].join(" ")}
              >
                <SourceFavicon url={s.url} />
                <span className="flex-1 truncate">{s.name}</span>
                <span className="rounded bg-secondary/50 px-1 py-px text-[9px] font-medium text-muted-foreground/50">
                  {s.kind}
                </span>
              </Link>
            );
          })}
        </div>
      ),
  });
}

// ── UserFooter ──────────────────────────────────────────────────────────

function UserFooter() {
  const auth = useAuth();
  if (auth.status !== "authenticated") return null;

  const initials = auth.user.name
    ? auth.user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : auth.user.email[0]!.toUpperCase();

  return (
    <div className="shrink-0 border-t border-sidebar-border px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        {auth.user.avatarUrl ? (
          <img src={auth.user.avatarUrl} alt="" className="size-7 shrink-0 rounded-full" />
        ) : (
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
            {initials}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium text-foreground">
            {auth.user.name ?? auth.user.email}
          </p>
          {auth.organization && (
            <p className="truncate text-[10px] text-muted-foreground">{auth.organization.name}</p>
          )}
        </div>
        <form action={AUTH_PATHS.logout} method="post">
          <Button
            variant="ghost"
            size="icon-xs"
            type="submit"
            className="shrink-0 text-muted-foreground/50 hover:bg-sidebar-active hover:text-foreground"
            title="Sign out"
          >
            <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
              <path
                d="M6 2H3.5A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14H6M10.5 11.5L14 8l-3.5-3.5M14 8H6"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Button>
        </form>
      </div>
    </div>
  );
}

// ── SidebarContent ───────────────────────────────────────────────────────

function SidebarContent(props: { pathname: string; onNavigate?: () => void; showBrand?: boolean }) {
  const isHome = props.pathname === "/";
  const isSecrets = props.pathname === "/secrets";
  const isBilling = props.pathname === "/billing" || props.pathname.startsWith("/billing/");
  const isOrg = props.pathname === "/org";

  return (
    <>
      {props.showBrand !== false && (
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Link to="/" className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">executor</span>
          </Link>
        </div>
      )}

      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
        <NavItem to="/" label="Sources" active={isHome} onNavigate={props.onNavigate} />
        <NavItem to="/secrets" label="Secrets" active={isSecrets} onNavigate={props.onNavigate} />
        <NavItem to="/org" label="Organization" active={isOrg} onNavigate={props.onNavigate} />
        <NavItem to="/billing" label="Billing" active={isBilling} onNavigate={props.onNavigate} />

        <div className="mt-5 mb-1 px-2.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/50">
          <span>Sources</span>
        </div>

        <SourceList pathname={props.pathname} onNavigate={props.onNavigate} />
      </nav>

      <UserFooter />
    </>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

export function Shell() {
  const location = useLocation();
  const pathname = location.pathname;
  const lastPathname = useRef(pathname);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  if (lastPathname.current !== pathname) {
    lastPathname.current = pathname;
    if (mobileSidebarOpen) setMobileSidebarOpen(false);
  }

  // Lock scroll when mobile sidebar open
  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileSidebarOpen]);

  return (
    <div className="flex h-screen overflow-hidden">
      <CommandPalette sourcePlugins={sourcePlugins} />
      {/* Desktop sidebar */}
      <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
        <SidebarContent pathname={pathname} />
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          {/* oxlint-disable-next-line react/forbid-elements */}
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className="relative flex h-full w-[84vw] max-w-xs flex-col border-r border-sidebar-border bg-sidebar shadow-2xl">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
              <Link to="/" className="flex items-center gap-1.5">
                <span className="font-display text-base tracking-tight text-foreground">
                  executor
                </span>
              </Link>
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label="Close navigation"
                onClick={() => setMobileSidebarOpen(false)}
                className="text-sidebar-foreground hover:bg-sidebar-active hover:text-foreground"
              >
                <svg viewBox="0 0 16 16" className="size-3.5">
                  <path
                    d="M3 3l10 10M13 3L3 13"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </Button>
            </div>
            <SidebarContent
              pathname={pathname}
              onNavigate={() => setMobileSidebarOpen(false)}
              showBrand={false}
            />
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4 md:hidden">
          <Button
            variant="outline"
            size="icon-sm"
            type="button"
            aria-label="Open navigation"
            onClick={() => setMobileSidebarOpen(true)}
            className="bg-card hover:bg-accent/50"
          >
            <svg viewBox="0 0 16 16" className="size-4">
              <path
                d="M2 4h12M2 8h12M2 12h12"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </Button>
          <Link to="/" className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">executor</span>
          </Link>
          <div className="w-8 shrink-0" />
        </div>

        <Outlet />
      </main>
    </div>
  );
}

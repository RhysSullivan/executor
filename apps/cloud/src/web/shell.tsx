import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAtomValue, useAtomSet, Result } from "@effect-atom/atom-react";
import { sourcesAtom } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor/react/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@executor/react/components/dropdown-menu";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { SourceFavicon } from "@executor/react/components/source-favicon";
import { CommandPalette } from "@executor/react/components/command-palette";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { mcpSourcePlugin } from "@executor/plugin-mcp/react";
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { AUTH_PATHS } from "../auth/api";
import {
  createOrganization,
  organizationsAtom,
  switchOrganization,
  useAuth,
} from "./auth";

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
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
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
      <div className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</div>
    ),
    onFailure: () => (
      <div className="px-2.5 py-2 text-xs text-muted-foreground">No sources yet</div>
    ),
    onSuccess: ({ value }) =>
      value.length === 0 ? (
        <div className="px-2.5 py-2 text-sm leading-relaxed text-muted-foreground">
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
                  "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  active
                    ? "bg-sidebar-active text-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
                ].join(" ")}
              >
                <SourceFavicon url={s.url} />
                <span className="flex-1 truncate">{s.name}</span>
                <span className="rounded bg-secondary/50 px-1 py-px text-xs font-medium text-muted-foreground">
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

function initialsFor(name: string | null, email: string) {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }
  return email[0]!.toUpperCase();
}

function Avatar(props: { url: string | null; name: string | null; email: string; size?: "sm" | "md" }) {
  const size = props.size === "md" ? "size-8" : "size-7";
  const text = props.size === "md" ? "text-sm" : "text-xs";
  if (props.url) {
    return <img src={props.url} alt="" className={`${size} shrink-0 rounded-full`} />;
  }
  return (
    <div
      className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-primary/10 ${text} font-semibold text-primary`}
    >
      {initialsFor(props.name, props.email)}
    </div>
  );
}

function OrganizationSwitcherItems(props: { activeOrganizationId: string | null }) {
  const organizations = useAtomValue(organizationsAtom);
  const doSwitchOrganization = useAtomSet(switchOrganization, { mode: "promiseExit" });

  const handleSwitch = async (organizationId: string) => {
    if (organizationId === props.activeOrganizationId) return;
    const exit = await doSwitchOrganization({ payload: { organizationId } });
    if (exit._tag === "Success") window.location.reload();
  };

  return Result.match(organizations, {
    onInitial: () => <DropdownMenuItem disabled>Loading…</DropdownMenuItem>,
    onFailure: () => <DropdownMenuItem disabled>Failed to load organizations</DropdownMenuItem>,
    onSuccess: ({ value }) =>
      value.organizations.length === 0 ? (
        <DropdownMenuItem disabled>No organizations</DropdownMenuItem>
      ) : (
        <>
          {value.organizations.map((organization) => {
            const isActive = organization.id === props.activeOrganizationId;
            return (
              <DropdownMenuItem
                key={organization.id}
                disabled={isActive}
                onClick={() => handleSwitch(organization.id)}
                className="text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                {isActive && <CheckIcon />}
              </DropdownMenuItem>
            );
          })}
        </>
      ),
  });
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="ml-auto size-3 text-muted-foreground">
      <path
        d="M3.5 8.5L6.5 11.5L12.5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UserFooter() {
  const auth = useAuth();
  const doCreateOrganization = useAtomSet(createOrganization, { mode: "promiseExit" });
  const [createOrganizationOpen, setCreateOrganizationOpen] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const [createOrganizationError, setCreateOrganizationError] = useState<string | null>(null);
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  if (auth.status !== "authenticated") return null;

  const suggestedOrganizationName =
    auth.user.name?.trim() !== "" && auth.user.name != null
      ? `${auth.user.name}'s Organization`
      : "New Organization";

  const openCreateOrganization = () => {
    setOrganizationName(suggestedOrganizationName);
    setCreateOrganizationError(null);
    setCreateOrganizationOpen(true);
  };

  const handleCreateOrganization = async () => {
    const name = organizationName.trim();
    if (!name) {
      setCreateOrganizationError("Organization name is required.");
      return;
    }

    setCreatingOrganization(true);
    setCreateOrganizationError(null);
    const exit = await doCreateOrganization({ payload: { name } });
    if (exit._tag === "Success") {
      window.location.reload();
    } else {
      setCreateOrganizationError("Failed to create organization.");
    }

    setCreatingOrganization(false);
  };

  return (
    <div className="shrink-0 border-t border-sidebar-border px-3 py-2.5">
      <Dialog
        open={createOrganizationOpen}
        onOpenChange={(open) => {
          setCreateOrganizationOpen(open);
          if (!open) {
            setOrganizationName(suggestedOrganizationName);
            setCreateOrganizationError(null);
            setCreatingOrganization(false);
          }
        }}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="flex h-auto w-full items-center justify-start gap-2.5 rounded-md px-1 py-1 text-left hover:bg-sidebar-active/60"
            >
              <Avatar
                url={auth.user.avatarUrl}
                name={auth.user.name}
                email={auth.user.email}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">
                  {auth.user.name ?? auth.user.email}
                </p>
                {auth.organization && (
                  <p className="truncate text-xs text-muted-foreground">{auth.organization.name}</p>
                )}
              </div>
              <svg
                viewBox="0 0 16 16"
                fill="none"
                className="size-3.5 shrink-0 text-muted-foreground"
              >
                <path
                  d="M4 6l4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Organization
            </DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {auth.organization?.name ?? "No organization"}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                <OrganizationSwitcherItems activeOrganizationId={auth.organization?.id ?? null} />
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-xs"
                  onSelect={(event) => {
                    event.preventDefault();
                    openCreateOrganization();
                  }}
                >
                  Create organization
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Signed in as
            </DropdownMenuLabel>
            <DropdownMenuItem disabled className="gap-2 text-xs opacity-100">
              <Avatar url={auth.user.avatarUrl} name={auth.user.name} email={auth.user.email} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">
                  {auth.user.name ?? auth.user.email}
                </p>
                {auth.user.name && (
                  <p className="truncate text-muted-foreground">{auth.user.email}</p>
                )}
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-xs text-destructive focus:text-destructive"
              onClick={async () => {
                await fetch(AUTH_PATHS.logout, { method: "POST" });
                window.location.href = "/";
              }}
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Create organization</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              Add another organization under your current account and switch into it immediately.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-3">
            <div className="grid gap-1.5">
              <Label
                htmlFor="organization-name"
                className="text-sm font-medium uppercase tracking-wider text-muted-foreground"
              >
                Organization name
              </Label>
              <Input
                id="organization-name"
                value={organizationName}
                placeholder="Northwind Labs"
                autoFocus
                onChange={(event) => {
                  setOrganizationName((event.target as HTMLInputElement).value);
                  if (createOrganizationError) setCreateOrganizationError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleCreateOrganization();
                }}
                className="h-9 text-sm"
              />
            </div>

            {createOrganizationError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-sm text-destructive">{createOrganizationError}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={creatingOrganization}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={() => void handleCreateOrganization()}
              disabled={!organizationName.trim() || creatingOrganization}
            >
              {creatingOrganization ? "Creating…" : "Create organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

        <div className="mt-5 mb-1 px-2.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
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

import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useAtomSet, Result } from "@effect-atom/atom-react";
import { sourcesAtom } from "@executor/react/api/atoms";
import { RoutesProvider, type AppRoutes } from "@executor/react/api/routes-context";
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
import { SourceFavicon } from "@executor/react/components/source-favicon";
import { CommandPalette } from "@executor/react/components/command-palette";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { mcpSourcePlugin } from "@executor/plugin-mcp/react";
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { AUTH_PATHS } from "../auth/api";
import { organizationsAtom, switchOrganization, useAuth } from "./auth";
import {
  CreateOrganizationFields,
  useCreateOrganizationForm,
} from "./components/create-organization-form";

const sourcePlugins = [
  openApiSourcePlugin,
  mcpSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

// ── NavItem ──────────────────────────────────────────────────────────────
//
// The cloud sidebar only links to the top-level `/$org/*` routes. TanStack's
// Link is typed against the generated route tree, so rather than trying to
// thread a generic `to` through we bind directly here. The caller passes a
// `kind` discriminator and we render the matching Link.

type NavItemKind = "home" | "secrets" | "settings" | "billing";

type NavItemProps = {
  kind: NavItemKind;
  params: { org: string };
  label: string;
  active: boolean;
  onNavigate?: () => void;
};

function NavItem(props: NavItemProps) {
  const className = [
    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
    props.active
      ? "bg-sidebar-active text-foreground font-medium"
      : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
  ].join(" ");

  const label = props.label;

  switch (props.kind) {
    case "home":
      return (
        <Link to="/$org" params={props.params} onClick={props.onNavigate} className={className}>
          {label}
        </Link>
      );
    case "secrets":
      return (
        <Link
          to="/$org/secrets"
          params={props.params}
          onClick={props.onNavigate}
          className={className}
        >
          {label}
        </Link>
      );
    case "settings":
      return (
        <Link
          to="/$org/settings"
          params={props.params}
          onClick={props.onNavigate}
          className={className}
        >
          {label}
        </Link>
      );
    case "billing":
      return (
        <Link
          to="/$org/billing"
          params={props.params}
          onClick={props.onNavigate}
          className={className}
        >
          {label}
        </Link>
      );
  }
}

// ── SourceList ───────────────────────────────────────────────────────────

function SourceList(props: { pathname: string; orgSlug: string; onNavigate?: () => void }) {
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
            const detailPath = `/${props.orgSlug}/sources/${s.id}`;
            const active =
              props.pathname === detailPath || props.pathname.startsWith(`${detailPath}/`);
            return (
              <Link
                key={s.id}
                to="/$org/sources/$namespace"
                params={{ org: props.orgSlug, namespace: s.id }}
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

  const handleSwitch = async (organizationId: string, slug: string) => {
    if (organizationId === props.activeOrganizationId) return;
    const exit = await doSwitchOrganization({ payload: { organizationId } });
    // Hard-navigate to the new org's scoped URL. A plain reload would
    // keep us on the current `/:oldSlug/...` path and immediately trip
    // the slug-mismatch reconcile in the $org layout, causing a second
    // round-trip; jumping straight to the new slug is one hop.
    if (exit._tag === "Success") window.location.assign(`/${slug}/`);
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
                onClick={() => handleSwitch(organization.id, organization.slug)}
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
  const [createOrganizationOpen, setCreateOrganizationOpen] = useState(false);

  const suggestedOrganizationName =
    auth.status === "authenticated" &&
    auth.user.name?.trim() !== "" &&
    auth.user.name != null
      ? `${auth.user.name}'s Organization`
      : "New Organization";

  const form = useCreateOrganizationForm({
    defaultName: suggestedOrganizationName,
    onSuccess: (org) => window.location.assign(`/${org.slug}/`),
  });

  if (auth.status !== "authenticated") return null;

  const openCreateOrganization = () => {
    form.reset(suggestedOrganizationName);
    setCreateOrganizationOpen(true);
  };

  return (
    <div className="shrink-0 border-t border-sidebar-border px-3 py-2.5">
      <Dialog
        open={createOrganizationOpen}
        onOpenChange={(open) => {
          setCreateOrganizationOpen(open);
          if (!open) form.reset(suggestedOrganizationName);
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

          <CreateOrganizationFields
            name={form.name}
            onNameChange={(name) => {
              form.setName(name);
              if (form.error) form.setError(null);
            }}
            error={form.error}
            onSubmit={() => void form.submit()}
          />

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={form.creating}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={() => void form.submit()}
              disabled={!form.canSubmit || form.creating}
            >
              {form.creating ? "Creating…" : "Create organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── SidebarContent ───────────────────────────────────────────────────────

function SidebarContent(props: {
  pathname: string;
  orgSlug: string;
  onNavigate?: () => void;
  showBrand?: boolean;
}) {
  const base = `/${props.orgSlug}`;
  const isHome = props.pathname === base || props.pathname === `${base}/`;
  const isSecrets = props.pathname === `${base}/secrets`;
  const isBilling =
    props.pathname === `${base}/billing` || props.pathname.startsWith(`${base}/billing/`);
  const isSettings = props.pathname === `${base}/settings`;
  const params = { org: props.orgSlug };

  return (
    <>
      {props.showBrand !== false && (
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Link to="/$org" params={params} className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">executor</span>
          </Link>
        </div>
      )}

      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
        <NavItem
          kind="home"
          params={params}
          label="Sources"
          active={isHome}
          onNavigate={props.onNavigate}
        />
        <NavItem
          kind="secrets"
          params={params}
          label="Secrets"
          active={isSecrets}
          onNavigate={props.onNavigate}
        />
        <NavItem
          kind="settings"
          params={params}
          label="Organization"
          active={isSettings}
          onNavigate={props.onNavigate}
        />
        <NavItem
          kind="billing"
          params={params}
          label="Billing"
          active={isBilling}
          onNavigate={props.onNavigate}
        />

        <div className="mt-5 mb-1 px-2.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <span>Sources</span>
        </div>

        <SourceList
          pathname={props.pathname}
          orgSlug={props.orgSlug}
          onNavigate={props.onNavigate}
        />
      </nav>

      <UserFooter />
    </>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

export function Shell() {
  const location = useLocation();
  const pathname = location.pathname;
  const auth = useAuth();
  // AuthGate only mounts Shell once we have an authenticated user with an
  // active org, so the slug is guaranteed present. We fall back to an empty
  // string to keep types happy — if it's missing we render nothing below.
  const orgSlug =
    auth.status === "authenticated" && auth.organization ? auth.organization.slug : "";
  const cloudRoutes = useMemo<AppRoutes>(
    () => ({
      home: { to: "/$org", params: { org: orgSlug } },
      sourceDetail: (sourceId) => ({
        to: "/$org/sources/$namespace",
        params: { org: orgSlug, namespace: sourceId },
      }),
      sourcesAdd: (pluginKey, search) => ({
        to: "/$org/sources/add/$pluginKey",
        params: { org: orgSlug, pluginKey },
        search,
      }),
    }),
    [orgSlug],
  );
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
    <RoutesProvider value={cloudRoutes}>
      <div className="flex h-screen overflow-hidden">
        <CommandPalette sourcePlugins={sourcePlugins} />
      {/* Desktop sidebar */}
      <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
        <SidebarContent pathname={pathname} orgSlug={orgSlug} />
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
              <Link to="/$org" params={{ org: orgSlug }} className="flex items-center gap-1.5">
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
              orgSlug={orgSlug}
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
          <Link to="/$org" params={{ org: orgSlug }} className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">executor</span>
          </Link>
          <div className="w-8 shrink-0" />
        </div>

        <Outlet />
        </main>
      </div>
    </RoutesProvider>
  );
}

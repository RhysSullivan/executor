import { Link, Outlet, useLocation, useMatchRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useSources, type Source } from "@executor/react";
import { sourcePluginsIndexPath } from "@executor/react/plugins";
import { cn } from "../lib/utils";
import { IconPlus, IconCopy, IconCheck, IconClose, IconMenu } from "./icons";
import { LoadableBlock } from "./loadable";
import { SourceFavicon } from "./source-favicon";
import {
  getSourceFrontendPaths,
  registeredFrontendPluginNavRoutes,
} from "../plugins";

// ── Status dot color ─────────────────────────────────────────────────────

const statusColor: Record<string, string> = {
  connected: "bg-primary",
  probing: "bg-amber-400",
  draft: "bg-muted-foreground/30",
  auth_required: "bg-amber-500",
  error: "bg-destructive",
};

type AppMetaEnv = {
  readonly VITE_APP_VERSION: string;
  readonly VITE_GITHUB_URL: string;
};

const { VITE_APP_VERSION, VITE_GITHUB_URL } = (import.meta as ImportMeta & {
  readonly env: AppMetaEnv;
}).env;

type UpdateChannel = "latest" | "beta";

const EXECUTOR_DIST_TAGS_PATH = "/v1/app/npm/dist-tags";

type ParsedVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number> | null;
};

const semverPattern =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const resolveUpdateChannel = (version: string): UpdateChannel =>
  version.includes("-beta.") ? "beta" : "latest";

const parseVersion = (version: string): ParsedVersion | null => {
  const match = version.trim().match(semverPattern);
  if (!match?.groups) {
    return null;
  }

  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease
      ? match.groups.prerelease.split(".").map((identifier) =>
          /^\d+$/.test(identifier) ? Number(identifier) : identifier,
        )
      : null,
  };
};

const comparePrereleaseIdentifiers = (
  left: ReadonlyArray<string | number> | null,
  right: ReadonlyArray<string | number> | null,
): number => {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];

    if (leftIdentifier === rightIdentifier) {
      continue;
    }

    if (leftIdentifier === undefined) {
      return -1;
    }

    if (rightIdentifier === undefined) {
      return 1;
    }

    if (typeof leftIdentifier === "number" && typeof rightIdentifier === "number") {
      return leftIdentifier < rightIdentifier ? -1 : 1;
    }

    if (typeof leftIdentifier === "number") {
      return -1;
    }

    if (typeof rightIdentifier === "number") {
      return 1;
    }

    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
};

const compareVersions = (left: string, right: string): number | null => {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) {
    return null;
  }

  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major < rightVersion.major ? -1 : 1;
  }

  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor < rightVersion.minor ? -1 : 1;
  }

  if (leftVersion.patch !== rightVersion.patch) {
    return leftVersion.patch < rightVersion.patch ? -1 : 1;
  }

  return comparePrereleaseIdentifiers(leftVersion.prerelease, rightVersion.prerelease);
};

// ── useLatestVersion ─────────────────────────────────────────────────────

function useLatestVersion(currentVersion: string) {
  const channel = resolveUpdateChannel(currentVersion);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(EXECUTOR_DIST_TAGS_PATH)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to load dist tags: ${res.status}`);
        }
        return res.json() as Promise<Partial<Record<UpdateChannel, string>>>;
      })
      .then((data: Partial<Record<UpdateChannel, string>>) => {
        if (!cancelled) {
          setLatestVersion(data[channel] ?? null);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [channel]);

  const updateAvailable =
    latestVersion !== null && compareVersions(currentVersion, latestVersion) === -1;

  return { latestVersion, updateAvailable, channel };
}

// ── UpdateCard ───────────────────────────────────────────────────────────

function UpdateCard(props: { latestVersion: string; channel: UpdateChannel }) {
  const command = `npm i -g executor@${props.channel}`;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [command]);

  return (
    <div className="mx-2 mb-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3">
      <div className="flex items-center gap-2">
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
            <path d="M8 3v7M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-foreground">Update available</p>
          <p className="text-[10px] text-muted-foreground">
            v{props.latestVersion}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/50 px-2.5 py-1.5 text-left transition-colors hover:bg-background/80"
      >
        <code className="truncate font-mono text-[10px] text-sidebar-foreground">
          {command}
        </code>
        <span className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground">
          {copied ? (
            <IconCheck className="size-3 text-primary" />
          ) : (
            <IconCopy className="size-3" />
          )}
        </span>
      </button>
    </div>
  );
}

// ── AppShell ─────────────────────────────────────────────────────────────
export function AppShell() {
  const sources = useSources();
  const location = useLocation();
  const matchRoute = useMatchRoute();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const isHome = matchRoute({ to: "/" });
  const isSecrets = matchRoute({ to: "/secrets" });
  const { latestVersion, updateAvailable, channel } = useLatestVersion(VITE_APP_VERSION);
  const mainPluginNavItems = registeredFrontendPluginNavRoutes.filter(
    ({ route }) => (route.nav?.section ?? "main") === "main",
  );
  const sourcePluginNavItems = registeredFrontendPluginNavRoutes.filter(
    ({ route }) => route.nav?.section === "sources",
  );

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileSidebarOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileSidebarOpen]);

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
        <SidebarContent
          isHome={!!isHome}
          isSecrets={!!isSecrets}
          latestVersion={latestVersion}
          updateAvailable={updateAvailable}
          channel={channel}
          locationPathname={location.pathname}
          mainPluginNavItems={mainPluginNavItems}
          sourcePluginNavItems={sourcePluginNavItems}
          sources={sources}
        />
      </aside>

      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
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
                <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  v3
                </span>
              </Link>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setMobileSidebarOpen(false)}
                className="inline-flex size-8 items-center justify-center rounded-md text-sidebar-foreground transition-colors hover:bg-sidebar-active hover:text-foreground"
              >
                <IconClose className="size-3.5" />
              </button>
            </div>
            <SidebarContent
              isHome={!!isHome}
              isSecrets={!!isSecrets}
              latestVersion={latestVersion}
              updateAvailable={updateAvailable}
              channel={channel}
              locationPathname={location.pathname}
              mainPluginNavItems={mainPluginNavItems}
              sourcePluginNavItems={sourcePluginNavItems}
              sources={sources}
              onNavigate={() => setMobileSidebarOpen(false)}
              showBrand={false}
            />
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4 md:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setMobileSidebarOpen(true)}
            className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-card text-foreground transition-colors hover:bg-accent/50"
          >
            <IconMenu className="size-4" />
          </button>
          <Link to="/" className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">
              executor
            </span>
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              v3
            </span>
          </Link>
          <div className="w-8 shrink-0" />
        </div>
        <Outlet />
      </main>
    </div>
  );
}

function SidebarContent(props: {
  isHome: boolean;
  isSecrets: boolean;
  latestVersion: string | null;
  updateAvailable: boolean;
  channel: UpdateChannel;
  locationPathname: string;
  mainPluginNavItems: typeof registeredFrontendPluginNavRoutes;
  sourcePluginNavItems: typeof registeredFrontendPluginNavRoutes;
  sources: ReturnType<typeof useSources>;
  onNavigate?: () => void;
  showBrand?: boolean;
}) {
  return (
    <>
      {props.showBrand !== false && (
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
      )}

      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
        <NavItem
          to="/"
          label="Dashboard"
          active={props.isHome}
          onNavigate={props.onNavigate}
        />
        <NavItem
          to="/secrets"
          label="Secrets"
          active={props.isSecrets}
          onNavigate={props.onNavigate}
        />
        {props.mainPluginNavItems.map(({ plugin, route, to }) => (
          <NavItem
            key={`${plugin.key}:${route.key}`}
            to={to}
            label={route.nav?.label ?? route.key}
            active={
              props.locationPathname === to
              || props.locationPathname.startsWith(`${to}/`)
            }
            onNavigate={props.onNavigate}
          />
        ))}

        <div className="mt-5 mb-1 px-2.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/50">
          <div className="flex items-center justify-between gap-2">
            <span>Sources</span>
            <Link
              to={sourcePluginsIndexPath}
              onClick={props.onNavigate}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium normal-case tracking-normal text-primary transition-colors hover:bg-sidebar-active hover:text-foreground"
            >
              <IconPlus className="size-3" />
              Add
            </Link>
          </div>
        </div>
        {props.sourcePluginNavItems.length > 0 && (
          <div className="mb-2 flex flex-col gap-px">
            {props.sourcePluginNavItems.map(({ plugin, route, to }) => (
              <NavItem
                key={`${plugin.key}:${route.key}`}
                to={to}
                label={route.nav?.label ?? route.key}
                active={
                  props.locationPathname === to
                  || props.locationPathname.startsWith(`${to}/`)
                }
                onNavigate={props.onNavigate}
              />
            ))}
          </div>
        )}
        <LoadableBlock loadable={props.sources} loading="Loading...">
          {(items) =>
            !Array.isArray(items) ? (
              <div className="px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
                Sources returned an unexpected payload.
              </div>
            ) : items.length === 0 ? (
              <div className="px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground/40">
                No sources yet
              </div>
            ) : (
              <div className="flex flex-col gap-px">
                {items.map((source) => (
                  <SourceItem
                    key={source.id}
                    pathname={props.locationPathname}
                    source={source}
                    onNavigate={props.onNavigate}
                  />
                ))}
              </div>
            )
          }
        </LoadableBlock>
      </nav>

      {props.updateAvailable && props.latestVersion && (
        <UpdateCard latestVersion={props.latestVersion} channel={props.channel} />
      )}

      <div className="shrink-0 border-t border-sidebar-border px-4 py-2.5">
        <div className="flex items-center justify-between text-[10px] leading-none">
          <span className="text-muted-foreground/70 tabular-nums">v{VITE_APP_VERSION}</span>
          <a
            href={VITE_GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            GitHub
          </a>
        </div>
      </div>
    </>
  );
}

// ── SourceItem ───────────────────────────────────────────────────────────

function SourceItem(props: {
  pathname: string;
  source: Source;
  onNavigate?: () => void;
}) {
  const paths = getSourceFrontendPaths(props.source.kind);

  if (!paths) {
    return (
      <div className="group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-sidebar-foreground/60">
        <div className="flex size-3 shrink-0 items-center justify-center text-muted-foreground/50">
          <SourceFavicon source={props.source} className="size-3" />
        </div>
        <span className="flex-1 truncate">{props.source.name}</span>
        <span
          className={cn("size-1.5 shrink-0 rounded-full", statusColor[props.source.status] ?? "bg-muted-foreground/30")}
          title={props.source.status}
        />
      </div>
    );
  }

  const detailPath = paths.detail(props.source.id);
  const active =
    props.pathname === detailPath
    || props.pathname.startsWith(`${detailPath}/`);

  return (
    <Link
      to={detailPath}
      search={{ tab: "model" }}
      onClick={props.onNavigate}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
        active
          ? "bg-sidebar-active text-foreground font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
      )}
    >
      <div className="flex size-3 shrink-0 items-center justify-center text-muted-foreground/50">
        <SourceFavicon source={props.source} className="size-3" />
      </div>
      <span className="flex-1 truncate">{props.source.name}</span>
      <span
        className={cn("size-1.5 shrink-0 rounded-full", statusColor[props.source.status] ?? "bg-muted-foreground/30")}
        title={props.source.status}
      />
    </Link>
  );
}

// ── NavItem ──────────────────────────────────────────────────────────────

function NavItem(props: {
  to: string;
  label: string;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={props.to}
      onClick={props.onNavigate}
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

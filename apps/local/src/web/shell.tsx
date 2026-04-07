import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useAtomRefresh,
  useAtomValue,
  Result,
  sourcesAtom,
  toolsAtom,
  useScope,
  useScopeInfo,
} from "@executor/react";
import { Button } from "@executor/ui/components/button";

// ── Env ─────────────────────────────────────────────────────────────────

type AppMetaEnv = {
  readonly VITE_APP_VERSION: string;
  readonly VITE_GITHUB_URL: string;
};

const { VITE_APP_VERSION, VITE_GITHUB_URL } = (import.meta as ImportMeta & {
  readonly env: AppMetaEnv;
}).env;

// ── Version helpers ─────────────────────────────────────────────────────

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
  if (!match?.groups) return null;
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease
      ? match.groups.prerelease.split(".").map((id) =>
          /^\d+$/.test(id) ? Number(id) : id,
        )
      : null,
  };
};

const comparePrereleaseIdentifiers = (
  left: ReadonlyArray<string | number> | null,
  right: ReadonlyArray<string | number> | null,
): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l < r ? -1 : 1;
    if (typeof l === "number") return -1;
    if (typeof r === "number") return 1;
    return l < r ? -1 : 1;
  }
  return 0;
};

const compareVersions = (left: string, right: string): number | null => {
  const lv = parseVersion(left);
  const rv = parseVersion(right);
  if (!lv || !rv) return null;
  if (lv.major !== rv.major) return lv.major < rv.major ? -1 : 1;
  if (lv.minor !== rv.minor) return lv.minor < rv.minor ? -1 : 1;
  if (lv.patch !== rv.patch) return lv.patch < rv.patch ? -1 : 1;
  return comparePrereleaseIdentifiers(lv.prerelease, rv.prerelease);
};

// ── useLatestVersion ────────────────────────────────────────────────────

function useLatestVersion(currentVersion: string) {
  const channel = resolveUpdateChannel(currentVersion);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(EXECUTOR_DIST_TAGS_PATH)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load dist tags: ${res.status}`);
        return res.json() as Promise<Partial<Record<UpdateChannel, string>>>;
      })
      .then((data) => {
        if (!cancelled) setLatestVersion(data[channel] ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [channel]);

  const updateAvailable =
    latestVersion !== null && compareVersions(currentVersion, latestVersion) === -1;

  return { latestVersion, updateAvailable, channel };
}

// ── UpdateCard ──────────────────────────────────────────────────────────

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
      <Button
        type="button"
        variant="outline"
        onClick={handleCopy}
        className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-lg border-border/60 bg-background/50 px-2.5 py-1.5 text-left hover:bg-background/80"
      >
        <code className="truncate font-mono text-[10px] text-sidebar-foreground">
          {command}
        </code>
        <span className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground">
          {copied ? (
            <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
              <path d="M3 8.5l3.5 3.5L13 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="size-3">
              <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M3 11V3.5A.5.5 0 013.5 3H11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          )}
        </span>
      </Button>
    </div>
  );
}

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
              props.pathname === detailPath ||
              props.pathname.startsWith(`${detailPath}/`);
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

// ── ScopeLabel ───────────────────────────────────────────────────────────

function ScopeLabel() {
  const { name } = useScopeInfo();
  // Show just the last folder name, with full path as tooltip
  const parts = name.replace(/\/+$/, "").split("/");
  const folder = parts[parts.length - 1] || name;

  return (
    <div className="mb-1.5 flex items-center gap-1.5 rounded-md px-2.5 py-1.5" title={name}>
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5 shrink-0 text-muted-foreground/50">
        <path
          d="M2 4.5C2 3.67 2.67 3 3.5 3h3.09a1 1 0 0 1 .7.29l1.42 1.42a1 1 0 0 0 .7.29H12.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z"
          stroke="currentColor"
          strokeWidth="1.2"
        />
      </svg>
      <span className="truncate text-[12px] font-medium text-foreground/80">
        {folder}
      </span>
    </div>
  );
}

// ── SidebarContent ───────────────────────────────────────────────────────

function SidebarContent(props: {
  pathname: string;
  onNavigate?: () => void;
  showBrand?: boolean;
  updateAvailable: boolean;
  latestVersion: string | null;
  channel: UpdateChannel;
}) {
  const isHome = props.pathname === "/";
  const isSecrets = props.pathname === "/secrets";

  return (
    <>
      {props.showBrand !== false && (
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Link to="/" className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">
              executor
            </span>
          </Link>
        </div>
      )}

      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
        <ScopeLabel />
        <NavItem
          to="/"
          label="Sources"
          active={isHome}
          onNavigate={props.onNavigate}
        />
        <NavItem
          to="/secrets"
          label="Secrets"
          active={isSecrets}
          onNavigate={props.onNavigate}
        />

        {/* Sources list */}
        <div className="mt-5 mb-1 px-2.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/50">
          <span>Configured</span>
        </div>

        <SourceList pathname={props.pathname} onNavigate={props.onNavigate} />
      </nav>

      {props.updateAvailable && props.latestVersion && (
        <UpdateCard latestVersion={props.latestVersion} channel={props.channel} />
      )}

      {/* Footer */}
      <div className="shrink-0 border-t border-sidebar-border px-4 py-2.5">
        <div className="flex flex-col gap-1.5 text-[11px] leading-none">
          <a
            href={`${VITE_GITHUB_URL}/issues`}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            Feedback / bug?
          </a>
          <a
            href={VITE_GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            Star on GitHub
          </a>
          <span className="mt-0.5 text-[10px] text-muted-foreground/50 tabular-nums">v{VITE_APP_VERSION}</span>
        </div>
      </div>
    </>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

export function Shell() {
  const location = useLocation();
  const pathname = location.pathname;
  const scopeId = useScope();
  const refreshSources = useAtomRefresh(sourcesAtom(scopeId));
  const refreshTools = useAtomRefresh(toolsAtom(scopeId));
  const { latestVersion, updateAvailable, channel } = useLatestVersion(VITE_APP_VERSION);
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

  useEffect(() => {
    if (!import.meta.hot) {
      return;
    }

    const refreshBackendData = () => {
      refreshSources();
      refreshTools();
    };

    import.meta.hot.on("executor:backend-updated", refreshBackendData);

    return () => {
      import.meta.hot?.off("executor:backend-updated", refreshBackendData);
    };
  }, [refreshSources, refreshTools]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
        <SidebarContent
          pathname={pathname}
          updateAvailable={updateAvailable}
          latestVersion={latestVersion}
          channel={channel}
        />
      </aside>

      {/* Mobile sidebar overlay */}
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
              </Link>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setMobileSidebarOpen(false)}
                className="size-8 flex items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-active hover:text-foreground"
              >
                <svg viewBox="0 0 16 16" className="size-3.5">
                  <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <SidebarContent
              pathname={pathname}
              onNavigate={() => setMobileSidebarOpen(false)}
              showBrand={false}
              updateAvailable={updateAvailable}
              latestVersion={latestVersion}
              channel={channel}
            />
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4 md:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setMobileSidebarOpen(true)}
            className="size-8 flex items-center justify-center rounded-md border border-border bg-card hover:bg-accent/50"
          >
            <svg viewBox="0 0 16 16" className="size-4">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
          <Link to="/" className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">
              executor
            </span>
          </Link>
          <div className="w-8 shrink-0" />
        </div>

        {/* Outlet — pages control their own padding/scroll */}
        <Outlet />
      </main>
    </div>
  );
}

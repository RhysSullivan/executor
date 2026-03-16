import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useSources, type Source } from "@executor/react";
import { cn } from "../lib/utils";
import { IconPlus, IconCopy, IconCheck } from "./icons";
import { LoadableBlock } from "./loadable";
import { SourceFavicon } from "./source-favicon";

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
    fetch("https://registry.npmjs.org/-/package/executor/dist-tags")
      .then((res) => res.json())
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
  const matchRoute = useMatchRoute();
  const isHome = matchRoute({ to: "/" });
  const isSecrets = matchRoute({ to: "/secrets" });
  const { latestVersion, updateAvailable, channel } = useLatestVersion(VITE_APP_VERSION);
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
          <NavItem to="/secrets" label="Secrets" active={!!isSecrets} />

          {/* Sources */}
          <div className="mt-5 mb-1 px-2.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/50">
            <div className="flex items-center justify-between gap-2">
              <span>Sources</span>
              <Link
                to="/sources/add"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium normal-case tracking-normal text-primary transition-colors hover:bg-sidebar-active hover:text-foreground"
              >
                <IconPlus className="size-3" />
                Add
              </Link>
            </div>
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

        {/* Update available */}
        {updateAvailable && latestVersion && (
          <UpdateCard latestVersion={latestVersion} channel={channel} />
        )}

        {/* Footer */}
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
      <div className="flex size-3 shrink-0 items-center justify-center text-muted-foreground/50">
        <SourceFavicon endpoint={source.endpoint} kind={source.kind} className="size-3" />
      </div>
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

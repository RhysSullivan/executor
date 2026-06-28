// The sidebar "update available" card, shared by both shells (the local/desktop
// single-user shell in @executor-js/app and the multiplayer shell here). One
// `<SidebarUpdateCard />` encapsulates the whole decision:
//
//   - in the desktop app (the bridge is present): a native "Restart to update"
//     action wired to electron-updater (see ../hooks/desktop-update), and
//   - on web / CLI-served installs: the npm upgrade command, lit up when the
//     `/v1/app/npm/dist-tags` endpoint reports a newer version for the channel.
//
// The semver verdict comes from @executor-js/api so the card and the CLI notice
// can never disagree.
import { useCallback, useEffect, useState } from "react";

import { Effect, Exit } from "effect";
import { compareVersions, resolveUpdateChannel, type UpdateChannel } from "@executor-js/api";

import { Button } from "./button";
import { toast } from "./sonner";
import { copyToClipboard } from "../lib/clipboard";
import { type DesktopUpdate, useDesktopUpdate } from "../hooks/desktop-update";

const EXECUTOR_DIST_TAGS_PATH = "/v1/app/npm/dist-tags";

const APP_VERSION = (
  import.meta as ImportMeta & { readonly env?: { readonly VITE_APP_VERSION?: string } }
).env?.VITE_APP_VERSION;

// ── useLatestVersion ────────────────────────────────────────────────────

function useLatestVersion(currentVersion: string | undefined) {
  const channel: UpdateChannel = currentVersion ? resolveUpdateChannel(currentVersion) : "latest";
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!currentVersion) return;
    let cancelled = false;
    void Effect.runPromiseExit(
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(EXECUTOR_DIST_TAGS_PATH);
          if (!res.ok) return null;
          return (await res.json()) as Partial<Record<UpdateChannel, string>>;
        },
        catch: (cause) => cause,
      }),
    ).then((exit) => {
      if (!cancelled && Exit.isSuccess(exit)) {
        setLatestVersion(exit.value?.[channel] ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [channel, currentVersion]);

  const updateAvailable =
    currentVersion !== undefined &&
    latestVersion !== null &&
    compareVersions(currentVersion, latestVersion) === -1;

  return { latestVersion, updateAvailable, channel };
}

// ── UpdateCard (web / CLI install: copyable npm command) ─────────────────

function UpdateCard(props: { latestVersion: string; channel: UpdateChannel }) {
  const command = `npm i -g executor@${props.channel}`;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void copyToClipboard(command).then((ok) => {
      if (!ok) {
        toast.error("Failed to copy to clipboard");
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [command]);

  return (
    <div className="mx-2 mb-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3">
      <div className="flex items-center gap-2">
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
            <path
              d="M8 3v7M5 7l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Update available</p>
          <p className="text-sm text-muted-foreground">v{props.latestVersion}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={handleCopy}
        className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-lg border-border/60 bg-background/50 px-2.5 py-1.5 text-left hover:bg-background/80"
      >
        <code className="truncate font-mono text-xs text-sidebar-foreground">{command}</code>
        <span className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground">
          {copied ? (
            <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
              <path
                d="M3 8.5l3.5 3.5L13 4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="size-3">
              <rect
                x="5"
                y="5"
                width="8"
                height="8"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M3 11V3.5A.5.5 0 013.5 3H11"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </span>
      </Button>
    </div>
  );
}

// ── DesktopUpdateCard (desktop app: native restart action) ───────────────

function DesktopUpdateCard(props: { update: DesktopUpdate }) {
  const { status, install } = props.update;
  const version = "version" in status ? status.version : null;

  const action = (() => {
    if (status.state === "downloaded") {
      return (
        <Button
          type="button"
          variant="outline"
          onClick={install}
          className="mt-2.5 w-full rounded-lg border-border/60 bg-background/50 px-2.5 py-1.5 text-xs hover:bg-background/80"
        >
          Restart to update
        </Button>
      );
    }
    if (status.state === "downloading") {
      return (
        <p className="mt-2.5 text-xs text-muted-foreground tabular-nums">
          Downloading… {status.percent}%
        </p>
      );
    }
    if (status.state === "available") {
      return <p className="mt-2.5 text-xs text-muted-foreground">Preparing update…</p>;
    }
    if (status.state === "installing") {
      return <p className="mt-2.5 text-xs text-muted-foreground">Restarting…</p>;
    }
    return null;
  })();

  return (
    <div className="mx-2 mb-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3">
      <div className="flex items-center gap-2">
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
            <path
              d="M8 3v7M5 7l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Update available</p>
          {version && <p className="text-sm text-muted-foreground">v{version}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

// ── SidebarUpdateCard (the only export the shells consume) ────────────────

/**
 * The sidebar update card, or null when no update is available. Reads the
 * build's `VITE_APP_VERSION` and the desktop bridge itself, so a shell just
 * drops it in above its footer. Hook order is stable across renders.
 */
export function SidebarUpdateCard(): React.ReactElement | null {
  const desktopUpdate = useDesktopUpdate();
  const { latestVersion, updateAvailable, channel } = useLatestVersion(APP_VERSION);

  // In the desktop app electron-updater owns updates, so show the native card
  // and never the npm command. Web and CLI-served installs show the npm card.
  if (desktopUpdate) {
    return desktopUpdate.status.state !== "idle" ? (
      <DesktopUpdateCard update={desktopUpdate} />
    ) : null;
  }
  return updateAvailable && latestVersion ? (
    <UpdateCard latestVersion={latestVersion} channel={channel} />
  ) : null;
}

/* oxlint-disable react/forbid-elements -- plugin component uses raw HTML controls per SDK convention; see @executor-js/plugin-example for the same pattern */
/**
 * @executor-js/plugin-desktop-settings/client
 *
 * A single page mounted at `/plugins/desktop-settings/` that lets the user
 * configure the Electron sidecar's port, auth, and password. Talks to the
 * main process via `window.executor.*` (exposed by `apps/desktop/src/preload`).
 *
 * The plugin is bundled into apps/local's renderer too (because executor
 * web + desktop share the same client bundle pipeline), but the page
 * only registers a nav entry when `window.executor` is present at
 * module-init time — so the web UI doesn't show a non-functional link.
 */

import { useCallback, useEffect, useState } from "react";
import { defineClientPlugin } from "@executor-js/sdk/client";

// ---------------------------------------------------------------------------
// Shape of the values the desktop preload exposes. Kept inline rather than
// imported from @executor-js/plugin-desktop-settings (or a shared package)
// so this client bundle has no runtime dependency on the Electron
// surface — when `window.executor` is undefined (web), the page silently
// no-ops instead of crashing.
// ---------------------------------------------------------------------------

interface DesktopServerSettings {
  readonly port: number;
  readonly requireAuth: boolean;
  readonly password: string;
}

interface ExecutorBridge {
  readonly getSettings: () => Promise<DesktopServerSettings>;
  readonly updateSettings: (
    patch: Partial<DesktopServerSettings>,
  ) => Promise<DesktopServerSettings>;
  readonly regeneratePassword: () => Promise<DesktopServerSettings>;
  readonly restartServer: () => Promise<{ readonly port: number; readonly baseUrl: string }>;
}

const readBridge = (): ExecutorBridge | null => {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { readonly executor?: ExecutorBridge }).executor;
  if (!candidate || typeof candidate.getSettings !== "function") return null;
  return candidate;
};

const inDesktop = readBridge() !== null;

// Normalize an IPC rejection into a user-facing string at this UI boundary.
// The renderer doesn't get typed errors back from Electron's invoke channel.
// We don't pull `err.message` out — the structured error doesn't help the
// user, only "save failed" matters. The main process logs the full error.
const describeIpcError = (_err: unknown): string =>
  "Save failed — check the desktop console for details.";

// ---------------------------------------------------------------------------
// SettingsPage
// ---------------------------------------------------------------------------

function SettingsPage() {
  const bridge = readBridge();
  const [settings, setSettings] = useState<DesktopServerSettings | null>(null);
  const [draft, setDraft] = useState<DesktopServerSettings | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "restarting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    void bridge.getSettings().then((s) => {
      setSettings(s);
      setDraft(s);
    });
  }, [bridge]);

  const apply = useCallback(
    async (patch: Partial<DesktopServerSettings>) => {
      if (!bridge) return;
      setStatus("saving");
      setError(null);
      let next: DesktopServerSettings;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: renderer ↔ Electron IPC, errors surface in the form
      try {
        next = await bridge.updateSettings(patch);
      } catch (err) {
        setError(describeIpcError(err));
        setStatus("error");
        return;
      }
      setSettings(next);
      setDraft(next);
      setStatus("restarting");
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: same as above
      try {
        await bridge.restartServer();
      } catch (err) {
        setError(describeIpcError(err));
        setStatus("error");
        return;
      }
      // Window reload happens on the main side after restart resolves.
      setStatus("idle");
    },
    [bridge],
  );

  const regenerate = useCallback(async () => {
    if (!bridge) return;
    setStatus("saving");
    let next: DesktopServerSettings;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: renderer ↔ Electron IPC
    try {
      next = await bridge.regeneratePassword();
    } catch (err) {
      setError(describeIpcError(err));
      setStatus("error");
      return;
    }
    setSettings(next);
    setDraft(next);
    setStatus("restarting");
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: renderer ↔ Electron IPC
    try {
      await bridge.restartServer();
    } catch (err) {
      setError(describeIpcError(err));
      setStatus("error");
      return;
    }
    setStatus("idle");
  }, [bridge]);

  if (!bridge) {
    return (
      <div style={{ maxWidth: 560, margin: "3rem auto", padding: "1.5rem" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Desktop server settings</h1>
        <p style={{ color: "var(--muted-foreground, #888)" }}>
          This panel configures the Executor Desktop app's local server. Open this page from the
          desktop app to change the port, auth, or password.
        </p>
      </div>
    );
  }

  if (!settings || !draft) {
    return <div style={{ maxWidth: 560, margin: "3rem auto", padding: "1.5rem" }}>Loading…</div>;
  }

  const dirty =
    draft.port !== settings.port ||
    draft.requireAuth !== settings.requireAuth ||
    draft.password !== settings.password;

  return (
    <div style={{ maxWidth: 640, margin: "2rem auto", padding: "1.5rem" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "0.25rem" }}>
        Desktop server
      </h1>
      <p
        style={{
          fontSize: "0.875rem",
          color: "var(--muted-foreground, #888)",
          marginBottom: "1.5rem",
        }}
      >
        Configure how the local HTTP server in the desktop app accepts connections. Changes restart
        the server immediately.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>Port</span>
          {/* oxlint-disable-next-line react/forbid-elements -- plugin component uses raw HTML controls per SDK convention */}
          <input
            type="number"
            min={1}
            max={65535}
            value={draft.port}
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
            style={{
              padding: "0.5rem 0.7rem",
              borderRadius: 6,
              border: "1px solid var(--border, #ddd)",
              fontFamily: "inherit",
              fontSize: "0.95rem",
              width: "8rem",
            }}
          />
          <span style={{ fontSize: "0.75rem", color: "var(--muted-foreground, #888)" }}>
            Default 4789. The desktop opens at <code>http://127.0.0.1:{draft.port}</code>.
          </span>
        </label>

        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
          {/* oxlint-disable-next-line react/forbid-elements -- plugin component uses raw HTML controls per SDK convention */}
          <input
            type="checkbox"
            checked={!draft.requireAuth}
            onChange={(e) => setDraft({ ...draft, requireAuth: !e.target.checked })}
            style={{ marginTop: "0.25rem" }}
          />
          <span style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>Use without a password</span>
            <span style={{ fontSize: "0.75rem", color: "var(--muted-foreground, #888)" }}>
              Disables HTTP Basic auth on the sidecar. Any process running as you on this machine
              can hit <code>/api</code> directly. The host allowlist still blocks browser-based
              attacks. Recommended only on personal devices.
            </span>
          </span>
        </label>

        {draft.requireAuth && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>Password</span>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <code
                style={{
                  flex: 1,
                  padding: "0.5rem 0.7rem",
                  borderRadius: 6,
                  border: "1px solid var(--border, #ddd)",
                  background: "var(--muted, #f5f5f5)",
                  fontSize: "0.85rem",
                  overflow: "auto",
                  whiteSpace: "nowrap",
                }}
              >
                {settings.password}
              </code>
              {/* oxlint-disable-next-line react/forbid-elements -- plugin component uses raw HTML controls per SDK convention */}
              <button
                type="button"
                onClick={() => void regenerate()}
                disabled={status !== "idle"}
                style={{
                  padding: "0.45rem 0.85rem",
                  borderRadius: 6,
                  border: "1px solid var(--border, #ddd)",
                  background: "var(--background, white)",
                  fontFamily: "inherit",
                  fontSize: "0.85rem",
                  cursor: status === "idle" ? "pointer" : "default",
                }}
              >
                Regenerate
              </button>
            </div>
            <span style={{ fontSize: "0.75rem", color: "var(--muted-foreground, #888)" }}>
              The renderer sends this as <code>Authorization: Basic</code>. AI clients using the
              HTTP MCP integration need this value too — regenerating invalidates existing client
              configs.
            </span>
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {/* oxlint-disable-next-line react/forbid-elements -- plugin component uses raw HTML controls per SDK convention */}
          <button
            type="button"
            disabled={!dirty || status !== "idle"}
            onClick={() =>
              void apply({
                port: draft.port,
                requireAuth: draft.requireAuth,
              })
            }
            style={{
              padding: "0.55rem 1.1rem",
              borderRadius: 6,
              border: "1px solid transparent",
              background: dirty ? "var(--primary, #0d0d10)" : "var(--muted, #eee)",
              color: dirty ? "var(--primary-foreground, white)" : "var(--muted-foreground, #888)",
              fontFamily: "inherit",
              fontSize: "0.9rem",
              cursor: dirty && status === "idle" ? "pointer" : "default",
            }}
          >
            {status === "saving"
              ? "Saving…"
              : status === "restarting"
                ? "Restarting server…"
                : "Save"}
          </button>
          {error && (
            <span style={{ fontSize: "0.8rem", color: "var(--destructive, #c00)" }}>{error}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin spec
// ---------------------------------------------------------------------------

export default defineClientPlugin({
  id: "desktop-settings",
  pages: [
    {
      path: "/",
      component: SettingsPage,
      // Only contribute a nav entry when running inside the desktop app.
      // Web users see an empty Sources nav without a non-functional
      // "Settings" link.
      ...(inDesktop ? { nav: { label: "Settings" } } : {}),
    },
  ],
});

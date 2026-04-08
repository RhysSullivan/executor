import { useReducer, useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Badge } from "@executor/react/components/badge";
import { Spinner } from "@executor/react/components/spinner";
import { probeMcpEndpoint, addMcpSource, startMcpOAuth } from "./atoms";
import { mcpPresets, type McpPreset } from "../sdk/presets";

// ---------------------------------------------------------------------------
// Preset lookup
// ---------------------------------------------------------------------------

function findPreset(id: string | undefined): McpPreset | undefined {
  if (!id) return undefined;
  return mcpPresets.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// State machine (remote flow)
// ---------------------------------------------------------------------------

type OAuthTokens = {
  accessTokenSecretId: string;
  refreshTokenSecretId: string | null;
  tokenType: string;
  expiresAt: number | null;
  scope: string | null;
};

type ProbeResult = {
  connected: boolean;
  requiresOAuth: boolean;
  name: string;
  namespace: string;
  toolCount: number | null;
  serverName: string | null;
};

type State =
  | { step: "url"; url: string }
  | { step: "probing"; url: string }
  | { step: "probed"; url: string; probe: ProbeResult }
  | { step: "oauth-starting"; url: string; probe: ProbeResult }
  | { step: "oauth-waiting"; url: string; probe: ProbeResult; sessionId: string }
  | { step: "oauth-done"; url: string; probe: ProbeResult; tokens: OAuthTokens }
  | { step: "adding"; url: string; probe: ProbeResult; tokens: OAuthTokens | null }
  | { step: "error"; url: string; probe: ProbeResult | null; tokens: OAuthTokens | null; error: string };

type Action =
  | { type: "set-url"; url: string }
  | { type: "probe-start" }
  | { type: "probe-ok"; probe: ProbeResult }
  | { type: "probe-fail"; error: string }
  | { type: "oauth-start" }
  | { type: "oauth-waiting"; sessionId: string }
  | { type: "oauth-ok"; tokens: OAuthTokens }
  | { type: "oauth-fail"; error: string }
  | { type: "oauth-cancelled" }
  | { type: "add-start" }
  | { type: "add-fail"; error: string }
  | { type: "retry" };

const init: State = { step: "url", url: "" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set-url":
      return { step: "url", url: action.url };

    case "probe-start":
      return { step: "probing", url: state.url };

    case "probe-ok":
      return { step: "probed", url: state.url, probe: action.probe };

    case "probe-fail":
      return { step: "error", url: state.url, probe: null, tokens: null, error: action.error };

    case "oauth-start":
      if (state.step !== "probed" && state.step !== "error") return state;
      return { step: "oauth-starting", url: state.url, probe: state.step === "probed" ? state.probe : state.probe! };

    case "oauth-waiting":
      if (state.step !== "oauth-starting") return state;
      return { step: "oauth-waiting", url: state.url, probe: state.probe, sessionId: action.sessionId };

    case "oauth-ok":
      if (state.step !== "oauth-waiting") return state;
      return { step: "oauth-done", url: state.url, probe: state.probe, tokens: action.tokens };

    case "oauth-fail":
      if (state.step !== "oauth-starting" && state.step !== "oauth-waiting") return state;
      return { step: "error", url: state.url, probe: state.probe, tokens: null, error: action.error };

    case "oauth-cancelled":
      if (state.step !== "oauth-waiting") return state;
      return { step: "probed", url: state.url, probe: state.probe };

    case "add-start": {
      const tokens =
        state.step === "oauth-done" ? state.tokens
        : state.step === "probed" ? null
        : null;
      const probe =
        "probe" in state ? state.probe : null;
      if (!probe) return state;
      return { step: "adding", url: state.url, probe, tokens };
    }

    case "add-fail":
      if (state.step !== "adding") return state;
      return { step: "error", url: state.url, probe: state.probe, tokens: state.tokens, error: action.error };

    case "retry": {
      if (state.step !== "error") return state;
      return state.probe
        ? state.tokens
          ? { step: "oauth-done", url: state.url, probe: state.probe, tokens: state.tokens }
          : { step: "probed", url: state.url, probe: state.probe }
        : { step: "url", url: state.url };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// OAuth popup
// ---------------------------------------------------------------------------

type OAuthPopupResult =
  | { type: "executor:oauth-result"; ok: true; sessionId: string } & OAuthTokens
  | { type: "executor:oauth-result"; ok: false; sessionId: null; error: string };

function openOAuthPopup(
  url: string,
  onResult: (data: OAuthPopupResult) => void,
  onClosed?: () => void,
): void {
  const w = 600, h = 700;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  const popup = window.open(url, "mcp-oauth", `width=${w},height=${h},left=${left},top=${top},popup=1`);

  let settled = false;
  const settle = () => { settled = true; window.removeEventListener("message", onMsg); };

  const onMsg = (e: MessageEvent) => {
    if (e.origin === window.location.origin && e.data?.type === "executor:oauth-result" && !settled) {
      settle();
      onResult(e.data as OAuthPopupResult);
    }
  };
  window.addEventListener("message", onMsg);

  if (popup) {
    const iv = setInterval(() => {
      if (popup.closed) { clearInterval(iv); if (!settled) { settle(); onClosed?.(); } }
    }, 500);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AddMcpSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
  initialPreset?: string;
}) {
  const preset = findPreset(props.initialPreset);
  const isStdioPreset = preset?.transport === "stdio";

  const [transport, setTransport] = useState<"remote" | "stdio">(
    isStdioPreset ? "stdio" : "remote",
  );

  // --- Stdio state ---
  const [stdioCommand, setStdioCommand] = useState(
    isStdioPreset ? preset.command : "",
  );
  const [stdioArgs, setStdioArgs] = useState(
    isStdioPreset && preset.args ? preset.args.join(" ") : "",
  );
  const [stdioEnv, setStdioEnv] = useState("");
  const [stdioName, setStdioName] = useState(
    isStdioPreset ? preset.name : "",
  );
  const [stdioAdding, setStdioAdding] = useState(false);
  const [stdioError, setStdioError] = useState<string | null>(null);

  // --- Remote state ---
  const remoteUrl =
    !isStdioPreset && preset?.transport === undefined && preset?.url
      ? preset.url
      : props.initialUrl ?? "";

  const [state, dispatch] = useReducer(
    reducer,
    remoteUrl ? { step: "url" as const, url: remoteUrl } : init,
  );

  const scopeId = useScope();
  const doProbe = useAtomSet(probeMcpEndpoint, { mode: "promise" });
  const doAdd = useAtomSet(addMcpSource, { mode: "promise" });
  const doStartOAuth = useAtomSet(startMcpOAuth, { mode: "promise" });

  const probe = "probe" in state ? state.probe : null;
  const tokens = "tokens" in state ? state.tokens : null;
  const isIdle = state.step === "url";
  const isProbing = state.step === "probing";
  const isAdding = state.step === "adding";
  const isOAuthBusy = state.step === "oauth-starting" || state.step === "oauth-waiting";
  const needsOAuth = probe?.requiresOAuth === true && !tokens;
  const canAdd = probe && !needsOAuth && !isAdding && !isOAuthBusy;
  const error = state.step === "error" ? state.error : null;

  // ---- Remote actions ----

  const handleProbe = useCallback(async () => {
    dispatch({ type: "probe-start" });
    try {
      const result = await doProbe({
        path: { scopeId },
        payload: { endpoint: state.url.trim() },
      });
      dispatch({ type: "probe-ok", probe: result });
    } catch (e) {
      dispatch({ type: "probe-fail", error: e instanceof Error ? e.message : "Failed to connect" });
    }
  }, [state.url, scopeId, doProbe]);

  const autoProbed = useRef(false);
  useEffect(() => {
    if (transport === "remote" && remoteUrl && !autoProbed.current) {
      autoProbed.current = true;
      handleProbe();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOAuth = useCallback(async () => {
    dispatch({ type: "oauth-start" });
    try {
      const redirectUrl = `${window.location.origin}/api/mcp/oauth/callback`;
      const result = await doStartOAuth({
        path: { scopeId },
        payload: { endpoint: state.url.trim(), redirectUrl },
      });
      dispatch({ type: "oauth-waiting", sessionId: result.sessionId });
      openOAuthPopup(
        result.authorizationUrl,
        (data) => {
          if (data.ok) {
            dispatch({
              type: "oauth-ok",
              tokens: {
                accessTokenSecretId: data.accessTokenSecretId,
                refreshTokenSecretId: data.refreshTokenSecretId,
                tokenType: data.tokenType,
                expiresAt: data.expiresAt,
                scope: data.scope,
              },
            });
          } else {
            dispatch({ type: "oauth-fail", error: data.error });
          }
        },
        () => dispatch({ type: "oauth-cancelled" }),
      );
    } catch (e) {
      dispatch({ type: "oauth-fail", error: e instanceof Error ? e.message : "Failed to start OAuth" });
    }
  }, [state.url, doStartOAuth]);

  const handleAddRemote = useCallback(async () => {
    if (!probe) return;
    dispatch({ type: "add-start" });
    try {
      await doAdd({
        path: { scopeId },
        payload: {
          transport: "remote" as const,
          name: probe.serverName ?? probe.name,
          endpoint: state.url.trim(),
          auth: tokens
            ? {
                kind: "oauth2" as const,
                accessTokenSecretId: tokens.accessTokenSecretId,
                refreshTokenSecretId: tokens.refreshTokenSecretId,
                tokenType: tokens.tokenType,
                expiresAt: tokens.expiresAt,
                scope: tokens.scope,
              }
            : { kind: "none" as const },
        },
      });
      props.onComplete();
    } catch (e) {
      dispatch({ type: "add-fail", error: e instanceof Error ? e.message : "Failed to add source" });
    }
  }, [probe, tokens, state.url, doAdd, props]);

  // ---- Stdio actions ----

  const parseStdioArgs = (raw: string): string[] => {
    if (!raw.trim()) return [];
    const args: string[] = [];
    const regex = /[^\s"]+|"([^"]*)"/g;
    let match;
    while ((match = regex.exec(raw)) !== null) {
      args.push(match[1] ?? match[0]);
    }
    return args;
  };

  const parseStdioEnv = (raw: string): Record<string, string> | undefined => {
    if (!raw.trim()) return undefined;
    const env: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
    return Object.keys(env).length > 0 ? env : undefined;
  };

  const handleAddStdio = useCallback(async () => {
    const cmd = stdioCommand.trim();
    if (!cmd) return;
    setStdioAdding(true);
    setStdioError(null);
    try {
      await doAdd({
        path: { scopeId },
        payload: {
          transport: "stdio" as const,
          name: stdioName.trim() || cmd,
          command: cmd,
          args: parseStdioArgs(stdioArgs),
          env: parseStdioEnv(stdioEnv),
        },
      });
      props.onComplete();
    } catch (e) {
      setStdioError(e instanceof Error ? e.message : "Failed to add source");
      setStdioAdding(false);
    }
  }, [stdioCommand, stdioArgs, stdioEnv, stdioName, doAdd, scopeId, props]);

  // ---- Render ----

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add MCP Source</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Connect to an MCP server to discover and use its tools.
        </p>
      </div>

      {/* Transport toggle */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1">
        <button
          type="button"
          onClick={() => setTransport("remote")}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            transport === "remote"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Remote
        </button>
        <button
          type="button"
          onClick={() => setTransport("stdio")}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            transport === "stdio"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Stdio
        </button>
      </div>

      {transport === "remote" ? (
        <>
          {/* URL input */}
          <section className="space-y-2">
            <Label>Server URL</Label>
            <div className="flex gap-2">
              <Input
                value={state.url}
                onChange={(e) => dispatch({ type: "set-url", url: (e.target as HTMLInputElement).value })}
                placeholder="https://mcp.example.com"
                className="flex-1 font-mono text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && state.url.trim() && isIdle) handleProbe();
                }}
                disabled={isProbing}
              />
              {!probe && (
                <Button onClick={handleProbe} disabled={!state.url.trim() || isProbing}>
                  {isProbing ? <><Spinner className="size-3.5" /> Connecting…</> : "Connect"}
                </Button>
              )}
            </div>
            <p className="text-[12px] text-muted-foreground">
              Supports Streamable HTTP and SSE transports.
            </p>
          </section>

          {/* Server info card */}
          {probe && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <svg viewBox="0 0 16 16" className="size-4" fill="none">
                  <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M5 7h6M5 9.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-card-foreground leading-none">
                  {probe.serverName ?? probe.name}
                </p>
                <p className="mt-1 text-[12px] text-muted-foreground leading-none">
                  {probe.connected
                    ? `${probe.toolCount} tool${probe.toolCount !== 1 ? "s" : ""} available`
                    : "OAuth required to discover tools"}
                </p>
              </div>
              {probe.connected ? (
                <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400">
                  Connected
                </Badge>
              ) : (
                <Badge variant="outline" className="border-amber-500/20 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400">
                  OAuth required
                </Badge>
              )}
            </div>
          )}

          {/* OAuth section */}
          {probe?.requiresOAuth && !tokens && (
            <section className="space-y-2.5">
              {state.step === "probed" && (
                <Button onClick={handleOAuth} className="w-full" variant="outline">
                  <svg viewBox="0 0 16 16" fill="none" className="mr-1.5 size-3.5">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1z" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M8 4v4l2.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Sign in with OAuth
                </Button>
              )}

              {state.step === "oauth-starting" && (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                  <Spinner className="size-3.5" />
                  <span className="text-xs text-muted-foreground">Starting authorization…</span>
                </div>
              )}

              {state.step === "oauth-waiting" && (
                <div className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2.5">
                  <Spinner className="size-3.5 text-blue-500" />
                  <span className="text-xs text-blue-600 dark:text-blue-400">Waiting for authorization in popup…</span>
                </div>
              )}
            </section>
          )}

          {/* OAuth success */}
          {tokens && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
              <svg viewBox="0 0 16 16" fill="none" className="size-3.5 text-emerald-500">
                <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Authenticated</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="space-y-2">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-[12px] text-destructive">{error}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => dispatch({ type: "retry" })} className="text-xs">
                Try again
              </Button>
            </div>
          )}

          {/* Actions */}
          {(probe || isProbing) && (
            <div className="flex items-center justify-between border-t border-border pt-4">
              <Button variant="ghost" onClick={props.onCancel} disabled={isAdding}>
                Cancel
              </Button>
              <Button onClick={handleAddRemote} disabled={!canAdd}>
                {isAdding ? <><Spinner className="size-3.5" /> Adding…</> : "Add source"}
              </Button>
            </div>
          )}

          {/* Cancel when nothing probed yet */}
          {!probe && !isProbing && (
            <div className="flex items-center justify-between pt-1">
              <Button variant="ghost" onClick={props.onCancel}>Cancel</Button>
              <div />
            </div>
          )}
        </>
      ) : (
        <>
          {/* Stdio form */}
          <section className="space-y-4">
            <div className="space-y-2">
              <Label>Command</Label>
              <Input
                value={stdioCommand}
                onChange={(e) => setStdioCommand((e.target as HTMLInputElement).value)}
                placeholder="npx"
                className="font-mono text-sm"
              />
              <p className="text-[12px] text-muted-foreground">
                The executable to run (e.g. npx, uvx, node).
              </p>
            </div>

            <div className="space-y-2">
              <Label>Arguments</Label>
              <Input
                value={stdioArgs}
                onChange={(e) => setStdioArgs((e.target as HTMLInputElement).value)}
                placeholder="-y chrome-devtools-mcp@latest"
                className="font-mono text-sm"
              />
              <p className="text-[12px] text-muted-foreground">
                Space-separated arguments passed to the command.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Name <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                value={stdioName}
                onChange={(e) => setStdioName((e.target as HTMLInputElement).value)}
                placeholder="My MCP Server"
                className="text-sm"
              />
            </div>

            <div className="space-y-2">
              <Label>Environment variables <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <textarea
                value={stdioEnv}
                onChange={(e) => setStdioEnv(e.target.value)}
                placeholder={"KEY=value\nANOTHER=value"}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-[12px] text-muted-foreground">
                One per line, KEY=value format.
              </p>
            </div>
          </section>

          {/* Stdio error */}
          {stdioError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive">{stdioError}</p>
            </div>
          )}

          {/* Stdio actions */}
          <div className="flex items-center justify-between border-t border-border pt-4">
            <Button variant="ghost" onClick={props.onCancel} disabled={stdioAdding}>
              Cancel
            </Button>
            <Button onClick={handleAddStdio} disabled={!stdioCommand.trim() || stdioAdding}>
              {stdioAdding ? <><Spinner className="size-3.5" /> Adding…</> : "Add source"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

import { useReducer, useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Badge } from "@executor/react/components/badge";
import { RadioGroup, RadioGroupItem } from "@executor/react/components/radio-group";
import { Spinner } from "@executor/react/components/spinner";
import { SecretHeaderAuthRow } from "@executor/react/plugins/secret-header-auth";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
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

type RemoteAuthMode = "none" | "header" | "oauth2";

type PlainHeader = {
  name: string;
  value: string;
};

type State =
  | { step: "url"; url: string }
  | { step: "probing"; url: string }
  | { step: "probed"; url: string; probe: ProbeResult }
  | { step: "oauth-starting"; url: string; probe: ProbeResult }
  | { step: "oauth-waiting"; url: string; probe: ProbeResult; sessionId: string }
  | { step: "oauth-done"; url: string; probe: ProbeResult; tokens: OAuthTokens }
  | { step: "adding"; url: string; probe: ProbeResult; tokens: OAuthTokens | null }
  | {
      step: "error";
      url: string;
      probe: ProbeResult | null;
      tokens: OAuthTokens | null;
      error: string;
    };

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
      return {
        step: "oauth-starting",
        url: state.url,
        probe: state.step === "probed" ? state.probe : state.probe!,
      };

    case "oauth-waiting":
      if (state.step !== "oauth-starting") return state;
      return {
        step: "oauth-waiting",
        url: state.url,
        probe: state.probe,
        sessionId: action.sessionId,
      };

    case "oauth-ok":
      if (state.step !== "oauth-waiting") return state;
      return { step: "oauth-done", url: state.url, probe: state.probe, tokens: action.tokens };

    case "oauth-fail":
      if (state.step !== "oauth-starting" && state.step !== "oauth-waiting") return state;
      return {
        step: "error",
        url: state.url,
        probe: state.probe,
        tokens: null,
        error: action.error,
      };

    case "oauth-cancelled":
      if (state.step !== "oauth-waiting") return state;
      return { step: "probed", url: state.url, probe: state.probe };

    case "add-start": {
      const tokens =
        state.step === "oauth-done" ? state.tokens : state.step === "probed" ? null : null;
      const probe = "probe" in state ? state.probe : null;
      if (!probe) return state;
      return { step: "adding", url: state.url, probe, tokens };
    }

    case "add-fail":
      if (state.step !== "adding") return state;
      return {
        step: "error",
        url: state.url,
        probe: state.probe,
        tokens: state.tokens,
        error: action.error,
      };

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
  | ({ type: "executor:oauth-result"; ok: true; sessionId: string } & OAuthTokens)
  | { type: "executor:oauth-result"; ok: false; sessionId: null; error: string };

const OAUTH_RESULT_CHANNEL = "executor:mcp-oauth-result";

const isOAuthPopupResult = (value: unknown): value is OAuthPopupResult =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === "executor:oauth-result";

function openOAuthPopup(
  url: string,
  onResult: (data: OAuthPopupResult) => void,
  onOpenFailed?: () => void,
): () => void {
  const w = 600,
    h = 700;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;

  let settled = false;
  const channel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(OAUTH_RESULT_CHANNEL) : null;
  const settle = () => {
    if (settled) return;
    settled = true;
    window.removeEventListener("message", onMsg);
    channel?.close();
  };

  const handleResult = (data: unknown) => {
    if (!isOAuthPopupResult(data) || settled) return;
    settle();
    onResult(data);
  };

  const onMsg = (e: MessageEvent) => {
    if (e.origin === window.location.origin) handleResult(e.data);
  };
  window.addEventListener("message", onMsg);
  if (channel) channel.onmessage = (e) => handleResult(e.data);

  const popup = window.open(
    url,
    "mcp-oauth",
    `width=${w},height=${h},left=${left},top=${top},popup=1`,
  );
  if (!popup && !settled) {
    settle();
    queueMicrotask(() => onOpenFailed?.());
  }
  return settle;
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
  const [stdioCommand, setStdioCommand] = useState(isStdioPreset ? preset.command : "");
  const [stdioArgs, setStdioArgs] = useState(
    isStdioPreset && preset.args ? preset.args.join(" ") : "",
  );
  const [stdioEnv, setStdioEnv] = useState("");
  const [stdioName, setStdioName] = useState(isStdioPreset ? preset.name : "");
  const [stdioAdding, setStdioAdding] = useState(false);
  const [stdioError, setStdioError] = useState<string | null>(null);

  // --- Remote state ---
  const remoteUrl =
    !isStdioPreset && preset?.transport === undefined && preset?.url
      ? preset.url
      : (props.initialUrl ?? "");

  const [state, dispatch] = useReducer(
    reducer,
    remoteUrl ? { step: "url" as const, url: remoteUrl } : init,
  );

  const scopeId = useScope();
  const doProbe = useAtomSet(probeMcpEndpoint, { mode: "promise" });
  const doAdd = useAtomSet(addMcpSource, { mode: "promise" });
  const doStartOAuth = useAtomSet(startMcpOAuth, { mode: "promise" });
  const secretList = useSecretPickerSecrets();

  const [remoteAuthMode, setRemoteAuthMode] = useState<RemoteAuthMode>("none");
  const [remoteHeaderAuth, setRemoteHeaderAuth] = useState<{
    name: string;
    prefix?: string;
    presetKey?: string;
    secretId: string | null;
  }>({
    name: "Authorization",
    prefix: "Bearer ",
    presetKey: "bearer",
    secretId: null,
  });
  const [remoteHeaders, setRemoteHeaders] = useState<PlainHeader[]>([]);

  const probe = "probe" in state ? state.probe : null;
  const tokens = "tokens" in state ? state.tokens : null;
  const isIdle = state.step === "url";
  const isProbing = state.step === "probing";
  const isAdding = state.step === "adding";
  const isOAuthBusy = state.step === "oauth-starting" || state.step === "oauth-waiting";
  const canUseNone = probe?.requiresOAuth !== true;
  const headerAuthComplete = Boolean(remoteHeaderAuth.name.trim() && remoteHeaderAuth.secretId);
  const remoteHeadersComplete = remoteHeaders.every(
    (header) => header.name.trim() && header.value.trim(),
  );
  const authReady =
    remoteAuthMode === "none"
      ? canUseNone
      : remoteAuthMode === "header"
        ? headerAuthComplete
        : tokens !== null;
  const canAdd = Boolean(probe) && authReady && remoteHeadersComplete && !isAdding && !isOAuthBusy;
  const error = state.step === "error" ? state.error : null;

  // ---- Remote actions ----

  const handleProbe = useCallback(async () => {
    dispatch({ type: "probe-start" });
    try {
      const result = await doProbe({
        path: { scopeId },
        payload: { endpoint: state.url.trim() },
      });
      setRemoteAuthMode(result.requiresOAuth ? "oauth2" : "none");
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

  const oauthCleanup = useRef<(() => void) | null>(null);

  const handleOAuth = useCallback(async () => {
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    dispatch({ type: "oauth-start" });
    try {
      const redirectUrl = `${window.location.origin}/api/mcp/oauth/callback`;
      const result = await doStartOAuth({
        path: { scopeId },
        payload: { endpoint: state.url.trim(), redirectUrl },
      });
      dispatch({ type: "oauth-waiting", sessionId: result.sessionId });
      oauthCleanup.current = openOAuthPopup(
        result.authorizationUrl,
        (data) => {
          oauthCleanup.current = null;
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
        () => {
          oauthCleanup.current = null;
          dispatch({ type: "oauth-fail", error: "OAuth popup was blocked" });
        },
      );
    } catch (e) {
      dispatch({
        type: "oauth-fail",
        error: e instanceof Error ? e.message : "Failed to start OAuth",
      });
    }
  }, [state.url, scopeId, doStartOAuth]);

  const handleCancelOAuth = useCallback(() => {
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    dispatch({ type: "oauth-cancelled" });
  }, []);

  const handleAddRemote = useCallback(async () => {
    if (!probe) return;
    dispatch({ type: "add-start" });
    try {
      const auth =
        remoteAuthMode === "header"
          ? {
              kind: "header" as const,
              headerName: remoteHeaderAuth.name.trim(),
              secretId: remoteHeaderAuth.secretId!,
              ...(remoteHeaderAuth.prefix ? { prefix: remoteHeaderAuth.prefix } : {}),
            }
          : remoteAuthMode === "oauth2" && tokens
            ? {
                kind: "oauth2" as const,
                accessTokenSecretId: tokens.accessTokenSecretId,
                refreshTokenSecretId: tokens.refreshTokenSecretId,
                tokenType: tokens.tokenType,
                expiresAt: tokens.expiresAt,
                scope: tokens.scope,
              }
            : { kind: "none" as const };
      const headers = Object.fromEntries(
        remoteHeaders
          .map((header) => [header.name.trim(), header.value.trim()] as const)
          .filter(([name, value]) => name && value),
      );

      await doAdd({
        path: { scopeId },
        payload: {
          transport: "remote" as const,
          name: probe.serverName ?? probe.name,
          endpoint: state.url.trim(),
          auth,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      });
      props.onComplete();
    } catch (e) {
      dispatch({
        type: "add-fail",
        error: e instanceof Error ? e.message : "Failed to add source",
      });
    }
  }, [probe, remoteAuthMode, remoteHeaderAuth, remoteHeaders, tokens, state.url, doAdd, props]);

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
                onChange={(e) =>
                  dispatch({ type: "set-url", url: (e.target as HTMLInputElement).value })
                }
                placeholder="https://mcp.example.com"
                className="flex-1 font-mono text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && state.url.trim() && isIdle) handleProbe();
                }}
                disabled={isProbing}
              />
              {!probe && (
                <Button onClick={handleProbe} disabled={!state.url.trim() || isProbing}>
                  {isProbing ? (
                    <>
                      <Spinner className="size-3.5" /> Connecting…
                    </>
                  ) : (
                    "Connect"
                  )}
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
                  <rect
                    x="2"
                    y="3"
                    width="12"
                    height="10"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                  <path
                    d="M5 7h6M5 9.5h4"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
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
                <Badge
                  variant="outline"
                  className="border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
                >
                  Connected
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-amber-500/20 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400"
                >
                  OAuth required
                </Badge>
              )}
            </div>
          )}

          {/* Authentication */}
          {probe && (
            <section className="space-y-2.5">
              <Label>Authentication</Label>

              <RadioGroup
                value={remoteAuthMode}
                onValueChange={(value) => setRemoteAuthMode(value as RemoteAuthMode)}
                className="gap-1.5"
              >
                {!probe.requiresOAuth && (
                  <label
                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      remoteAuthMode === "none"
                        ? "border-primary/50 bg-primary/[0.03]"
                        : "border-border hover:bg-accent/50"
                    }`}
                  >
                    <RadioGroupItem value="none" />
                    <span className="text-xs font-medium text-foreground">None</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      no auth header
                    </span>
                  </label>
                )}

                <label
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    remoteAuthMode === "header"
                      ? "border-primary/50 bg-primary/[0.03]"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <RadioGroupItem value="header" />
                  <span className="text-xs font-medium text-foreground">Header</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    use a secret-backed auth header
                  </span>
                </label>

                {probe.requiresOAuth && (
                  <label
                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      remoteAuthMode === "oauth2"
                        ? "border-primary/50 bg-primary/[0.03]"
                        : "border-border hover:bg-accent/50"
                    }`}
                  >
                    <RadioGroupItem value="oauth2" />
                    <span className="text-xs font-medium text-foreground">OAuth</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      sign in with the server&apos;s OAuth flow
                    </span>
                  </label>
                )}
              </RadioGroup>

              {remoteAuthMode === "header" && (
                <SecretHeaderAuthRow
                  label="Auth header"
                  name={remoteHeaderAuth.name}
                  prefix={remoteHeaderAuth.prefix}
                  presetKey={remoteHeaderAuth.presetKey}
                  secretId={remoteHeaderAuth.secretId}
                  onChange={(update) =>
                    setRemoteHeaderAuth((current) => ({
                      ...current,
                      ...update,
                    }))
                  }
                  onSelectSecret={(secretId) =>
                    setRemoteHeaderAuth((current) => ({
                      ...current,
                      secretId,
                    }))
                  }
                  existingSecrets={secretList}
                />
              )}

              {probe.requiresOAuth && remoteAuthMode === "oauth2" && !tokens && (
                <>
                  {state.step === "probed" && (
                    <Button onClick={handleOAuth} className="w-full" variant="outline">
                      <svg viewBox="0 0 16 16" fill="none" className="mr-1.5 size-3.5">
                        <path
                          d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1z"
                          stroke="currentColor"
                          strokeWidth="1.2"
                        />
                        <path
                          d="M8 4v4l2.5 1.5"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
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
                      <span className="text-xs text-blue-600 dark:text-blue-400">
                        Waiting for authorization in popup…
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleCancelOAuth}
                        className="ml-auto h-7 px-2 text-xs"
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </>
              )}

              {probe.requiresOAuth && remoteAuthMode === "oauth2" && tokens && (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
                  <svg viewBox="0 0 16 16" fill="none" className="size-3.5 text-emerald-500">
                    <path
                      d="M3 8.5l3 3 7-7"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    Authenticated
                  </span>
                </div>
              )}

              {remoteAuthMode === "none" && probe.requiresOAuth && (
                <p className="text-[12px] text-amber-600 dark:text-amber-400">
                  This server requires authentication before it can be added.
                </p>
              )}
            </section>
          )}

          {/* Additional headers */}
          {probe && (
            <section className="space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>Additional headers</Label>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    Plaintext headers sent with every request. Use authentication for secret-backed
                    auth headers.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() =>
                    setRemoteHeaders((headers) => [...headers, { name: "", value: "" }])
                  }
                >
                  + Add header
                </Button>
              </div>

              {remoteHeaders.length > 0 && (
                <div className="space-y-2">
                  {remoteHeaders.map((header, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-border bg-card p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Header
                        </Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() =>
                            setRemoteHeaders((headers) =>
                              headers.filter((_, headerIndex) => headerIndex !== index),
                            )
                          }
                        >
                          Remove
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Name
                          </Label>
                          <Input
                            value={header.name}
                            onChange={(event) =>
                              setRemoteHeaders((headers) =>
                                headers.map((current, headerIndex) =>
                                  headerIndex === index
                                    ? { ...current, name: (event.target as HTMLInputElement).value }
                                    : current,
                                ),
                              )
                            }
                            placeholder="X-Organization-Id"
                            className="h-8 text-xs font-mono"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Value
                          </Label>
                          <Input
                            value={header.value}
                            onChange={(event) =>
                              setRemoteHeaders((headers) =>
                                headers.map((current, headerIndex) =>
                                  headerIndex === index
                                    ? {
                                        ...current,
                                        value: (event.target as HTMLInputElement).value,
                                      }
                                    : current,
                                ),
                              )
                            }
                            placeholder="workspace-id"
                            className="h-8 text-xs font-mono"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Error */}
          {error && (
            <div className="space-y-2">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-[12px] text-destructive">{error}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => dispatch({ type: "retry" })}
                className="text-xs"
              >
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
                {isAdding ? (
                  <>
                    <Spinner className="size-3.5" /> Adding…
                  </>
                ) : (
                  "Add source"
                )}
              </Button>
            </div>
          )}

          {/* Cancel when nothing probed yet */}
          {!probe && !isProbing && (
            <div className="flex items-center justify-between pt-1">
              <Button variant="ghost" onClick={props.onCancel}>
                Cancel
              </Button>
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
              <Label>
                Name <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                value={stdioName}
                onChange={(e) => setStdioName((e.target as HTMLInputElement).value)}
                placeholder="My MCP Server"
                className="text-sm"
              />
            </div>

            <div className="space-y-2">
              <Label>
                Environment variables{" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <textarea
                value={stdioEnv}
                onChange={(e) => setStdioEnv(e.target.value)}
                placeholder={"KEY=value\nANOTHER=value"}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-[12px] text-muted-foreground">One per line, KEY=value format.</p>
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
              {stdioAdding ? (
                <>
                  <Spinner className="size-3.5" /> Adding…
                </>
              ) : (
                "Add source"
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

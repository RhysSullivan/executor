import { startTransition, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Source } from "@executor/react";
import {
  Result,
  defineExecutorPluginHttpApiClient,
  useAtomSet,
  useAtomValue,
  useExecutorMutation,
  useLocalInstallation,
  useSource,
} from "@executor/react";
import {
  Alert,
  Badge,
  Button,
  IconPencil,
  IconSpinner,
  Input,
  Label,
  Select,
  SourceToolExplorer,
  Textarea,
  parseSourceToolExplorerSearch,
  type SourceToolExplorerSearch,
  useSourcePluginNavigation,
  useSourcePluginRouteParams,
  useSourcePluginSearch,
} from "@executor/react/plugins";

import {
  mcpHttpApiExtension,
} from "@executor/plugin-mcp-http";
import {
  getFaviconUrlForRemoteUrl,
  getSourceFaviconUrl,
  type McpConnectInput,
  type McpConnectionAuth,
  type McpDiscoverResult,
  type McpOAuthPopupResult,
  type McpStartOAuthInput,
} from "@executor/plugin-mcp-shared";
import {
  asMcpRemoteTransportValue,
  defaultMcpRemoteTransportFields,
  defaultMcpStdioTransportFields,
  setMcpTransportFieldsTransport,
  type McpTransportFields,
  type McpTransportValue,
} from "./transport";
import {
  parseJsonStringArray,
  parseJsonStringMap,
} from "./json";
import {
  buildMcpRemoteConfigKey,
  mcpDiscoveryRequiresOAuth,
} from "./oauth-detection";

const OAUTH_STORAGE_PREFIX = "executor:mcp-oauth:";
const OAUTH_TIMEOUT_MS = 2 * 60_000;

const getMcpHttpClient = defineExecutorPluginHttpApiClient<"McpReactHttpClient">()(
  "McpReactHttpClient",
  [mcpHttpApiExtension] as const,
);

const defaultMcpInput = (): McpConnectInput => ({
  name: "My MCP Source",
  iconUrl: undefined,
  endpoint: "https://example.com/mcp",
  transport: "auto",
  queryParams: null,
  headers: null,
  command: null,
  args: null,
  env: null,
  cwd: null,
  auth: {
    kind: "none",
  },
});

const presetString = (
  search: Record<string, unknown>,
  key: string,
): string | null => {
  const value = search[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

const presetTransport = (
  search: Record<string, unknown>,
): McpConnectInput["transport"] => {
  const value = presetString(search, "presetTransport");
  return value === "auto" ||
      value === "streamable-http" ||
      value === "sse" ||
      value === "stdio"
    ? value
    : null;
};

const presetJsonStringMap = (
  search: Record<string, unknown>,
  key: string,
): Record<string, string> | null => {
  const value = presetString(search, key);
  return value ? parseJsonStringMap(key, value) : null;
};

const presetJsonStringArray = (
  search: Record<string, unknown>,
  key: string,
): Array<string> | null => {
  const value = presetString(search, key);
  return value ? parseJsonStringArray(key, value) : null;
};

const mcpInputFromSearch = (
  search: Record<string, unknown>,
): McpConnectInput => {
  const defaults = defaultMcpInput();
  const command = presetString(search, "presetCommand");
  const args = presetJsonStringArray(search, "presetArgs");
  const env = presetJsonStringMap(search, "presetEnv");
  const cwd = presetString(search, "presetCwd");
  const queryParams = presetJsonStringMap(search, "presetQueryParams");
  const headers = presetJsonStringMap(search, "presetHeaders");
  const transport = presetTransport(search)
    ?? (command ? "stdio" : defaults.transport);

  return {
    ...defaults,
    name: presetString(search, "presetName") ?? defaults.name,
    endpoint:
      command
        ? null
        : presetString(search, "presetEndpoint") ?? defaults.endpoint,
    transport,
    queryParams,
    headers,
    command,
    args,
    env,
    cwd,
  };
};

const stringifyStringMap = (
  value: Record<string, string> | null | undefined,
): string =>
  !value || Object.keys(value).length === 0
    ? ""
    : JSON.stringify(value, null, 2);

const stringifyStringArray = (
  value: ReadonlyArray<string> | null | undefined,
): string =>
  !value || value.length === 0 ? "" : JSON.stringify(value, null, 2);

const transportFieldsFromInput = (input: McpConnectInput): McpTransportFields =>
  input.transport === "stdio" || input.command
    ? defaultMcpStdioTransportFields({
        command: input.command ?? "",
        argsText: stringifyStringArray(input.args),
        envText: stringifyStringMap(input.env),
        cwd: input.cwd ?? "",
      })
    : {
        ...defaultMcpRemoteTransportFields(
          asMcpRemoteTransportValue(input.transport),
        ),
        queryParamsText: stringifyStringMap(input.queryParams),
        headersText: stringifyStringMap(input.headers),
      };

const waitForOauthPopupResult = async (
  sessionId: string,
): Promise<McpOAuthPopupResult> =>
  new Promise((resolve, reject) => {
    const storageKey = `${OAUTH_STORAGE_PREFIX}${sessionId}`;
    const startedAt = Date.now();

    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      window.clearInterval(intervalId);
    };

    const finish = (result: McpOAuthPopupResult) => {
      cleanup();
      try {
        window.localStorage.removeItem(storageKey);
      } catch {}
      resolve(result);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as McpOAuthPopupResult | undefined;
      if (!data || data.type !== "executor:oauth-result") {
        return;
      }

      if (data.ok && data.sessionId !== sessionId) {
        return;
      }

      finish(data);
    };

    window.addEventListener("message", handleMessage);
    const intervalId = window.setInterval(() => {
      if (Date.now() - startedAt > OAUTH_TIMEOUT_MS) {
        cleanup();
        reject(new Error("Timed out waiting for MCP OAuth to finish."));
        return;
      }

      try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) {
          return;
        }

        finish(JSON.parse(raw) as McpOAuthPopupResult);
      } catch {
        // Ignore malformed local storage and continue polling.
      }
    }, 400);
  });

const openOauthPopup = (): Window | null => {
  const popup = window.open("", "executor-mcp-oauth", "width=560,height=760");
  if (!popup) {
    return null;
  }

  try {
    popup.document.title = "Connecting";
    popup.document.body.innerHTML = `
      <main style="font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; color: #333;">
        <div style="width: 20px; height: 20px; border: 2px solid #e5e7eb; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.7s linear infinite; margin-bottom: 16px;"></div>
        <p style="margin: 0; font-size: 14px; color: #888;">Redirecting to sign in&hellip;</p>
        <style>
          @keyframes spin { to { transform: rotate(360deg); } }
          @media (prefers-color-scheme: dark) {
            main { background: #09090b; color: #fafafa !important; }
            p { color: #a1a1aa !important; }
            div { border-color: #3f3f46 !important; }
          }
        </style>
      </main>
    `;
  } catch {
    // Ignore cases where the browser does not allow touching the popup document.
  }

  return popup;
};

function McpSourceForm(props: {
  initialValue: McpConnectInput;
  mode: "create" | "edit";
  onSubmit: (input: McpConnectInput) => Promise<void>;
}) {
  const installation = useLocalInstallation();
  const client = getMcpHttpClient();
  const discoverSource = useAtomSet(
    client.mutation("mcp", "discoverSource"),
    { mode: "promise" },
  );
  const startOAuth = useAtomSet(
    client.mutation("mcp", "startOAuth"),
    { mode: "promise" },
  );
  const submitMutation = useExecutorMutation<McpConnectInput, void>(props.onSubmit);
  const [name, setName] = useState(props.initialValue.name);
  const [iconUrl, setIconUrl] = useState(props.initialValue.iconUrl ?? "");
  const [endpoint, setEndpoint] = useState(props.initialValue.endpoint ?? "");
  const [transportFields, setTransportFields] = useState<McpTransportFields>(
    transportFieldsFromInput(props.initialValue),
  );
  const [authKind, setAuthKind] = useState<McpConnectionAuth["kind"]>(
    props.initialValue.auth.kind,
  );
  const [oauthAuth, setOauthAuth] = useState<
    Extract<McpConnectionAuth, { kind: "oauth2" }> | null
  >(
    props.initialValue.auth.kind === "oauth2"
      ? props.initialValue.auth
      : null,
  );
  const [oauthStatus, setOauthStatus] = useState<"idle" | "pending" | "connected">(
    props.initialValue.auth.kind === "oauth2" ? "connected" : "idle",
  );
  const [detectedOauthRequired, setDetectedOauthRequired] = useState(
    props.initialValue.auth.kind === "oauth2",
  );
  const [lastDiscoveryKey, setLastDiscoveryKey] = useState<string | null>(
    props.initialValue.auth.kind === "oauth2"
      ? buildMcpRemoteConfigKey({
          transport: transportFields.transport,
          endpoint: props.initialValue.endpoint ?? "",
          queryParams: props.initialValue.queryParams,
        })
      : null,
  );
  const [oauthConnectionKey, setOauthConnectionKey] = useState<string | null>(
    props.initialValue.auth.kind === "oauth2"
      ? buildMcpRemoteConfigKey({
          transport: transportFields.transport,
          endpoint: props.initialValue.endpoint ?? "",
          queryParams: props.initialValue.queryParams,
        })
      : null,
  );
  const [error, setError] = useState<string | null>(null);

  const isStdio = transportFields.transport === "stdio";
  const resolvedIconUrl = iconUrl.trim()
    || (!isStdio ? getFaviconUrlForRemoteUrl(endpoint) : null)
    || getSourceFaviconUrl(name);
  const remoteQueryParamsText =
    transportFields.transport === "stdio"
      ? ""
      : transportFields.queryParamsText;
  const parsedRemoteQueryParams = (() => {
    if (isStdio) {
      return null;
    }

    try {
      return parseJsonStringMap("Query params", remoteQueryParamsText);
    } catch {
      return null;
    }
  })();
  const remoteConfigKey = (() => {
    try {
      return buildMcpRemoteConfigKey({
        transport: transportFields.transport,
        endpoint,
        queryParams: parsedRemoteQueryParams,
      });
    } catch {
      return null;
    }
  })();

  const runOauth = async (): Promise<Extract<McpConnectionAuth, { kind: "oauth2" }>> => {
    if (installation.status !== "ready") {
      throw new Error("Workspace is still loading.");
    }
    if (isStdio) {
      throw new Error("MCP OAuth is only available for remote MCP transports.");
    }

    const popup = openOauthPopup();
    if (!popup) {
      throw new Error("Failed opening MCP OAuth popup. Allow popups for this site and try again.");
    }

    const payload: McpStartOAuthInput = {
      endpoint: endpoint.trim(),
      queryParams: parseJsonStringMap("Query params", transportFields.queryParamsText),
      redirectUrl: new URL(
        "/v1/plugins/mcp/oauth/callback",
        window.location.origin,
      ).toString(),
    };

    let started: Awaited<ReturnType<typeof startOAuth>>;
    try {
      started = await startOAuth({
        path: {
          workspaceId: installation.data.scopeId,
        },
        payload,
      });
    } catch (cause) {
      popup.close();
      throw cause;
    }

    popup.location.replace(started.authorizationUrl);
    popup.focus();

    const result = await waitForOauthPopupResult(started.sessionId);
    if (!result.ok) {
      throw new Error(result.error);
    }

    setOauthAuth(result.auth);
    setOauthStatus("connected");
    setOauthConnectionKey(remoteConfigKey);
    return result.auth;
  };

  const runDiscovery = async (input: {
    mode: "auto" | "manual";
  }): Promise<McpDiscoverResult> => {
    if (installation.status !== "ready") {
      throw new Error("Workspace is still loading.");
    }
    if (isStdio || remoteConfigKey === null) {
      setDetectedOauthRequired(false);
      setLastDiscoveryKey(null);
      return null;
    }

    const payload = {
      endpoint: endpoint.trim(),
      queryParams:
        parseJsonStringMap("Query params", remoteQueryParamsText),
    };

    try {
      const discovered = await discoverSource({
        path: {
          workspaceId: installation.data.scopeId,
        },
        payload,
      });
      const oauthRequired = mcpDiscoveryRequiresOAuth(discovered);
      setDetectedOauthRequired(oauthRequired);
      setLastDiscoveryKey(remoteConfigKey);
      if (oauthRequired) {
        setAuthKind((current) => current === "oauth2" ? current : "oauth2");
      }
      return discovered;
    } catch (cause) {
      setDetectedOauthRequired(false);
      setLastDiscoveryKey(remoteConfigKey);
      if (input.mode === "manual") {
        throw cause;
      }
      return null;
    }
  };

  useEffect(() => {
    if (isStdio || remoteConfigKey === null) {
      setDetectedOauthRequired(false);
      setLastDiscoveryKey(null);
      return;
    }

    if (remoteConfigKey === lastDiscoveryKey) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void runDiscovery({ mode: "auto" });
    }, 450);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    endpoint,
    installation.status,
    isStdio,
    lastDiscoveryKey,
    remoteConfigKey,
    remoteQueryParamsText,
  ]);

  useEffect(() => {
    if (oauthConnectionKey === null || remoteConfigKey === oauthConnectionKey) {
      return;
    }

    setOauthAuth(null);
    setOauthStatus("idle");
    setOauthConnectionKey(null);
  }, [oauthConnectionKey, remoteConfigKey]);

  const buildInput = (
    connectedOauthAuth: Extract<McpConnectionAuth, { kind: "oauth2" }> | null = oauthAuth,
    authOverride?: McpConnectionAuth,
  ): McpConnectInput => ({
    name: name.trim(),
    ...(iconUrl.trim() ? { iconUrl: iconUrl.trim() } : {}),
    endpoint: isStdio ? null : (endpoint.trim() || null),
    transport:
      transportFields.transport === ""
        ? null
        : transportFields.transport,
    queryParams: isStdio
      ? null
      : parseJsonStringMap("Query params", transportFields.queryParamsText),
    headers: isStdio
      ? null
      : parseJsonStringMap("Headers", transportFields.headersText),
    command: isStdio ? transportFields.command.trim() || null : null,
    args: isStdio
      ? parseJsonStringArray("Args", transportFields.argsText)
      : null,
    env: isStdio
      ? parseJsonStringMap("Environment", transportFields.envText)
      : null,
    cwd: isStdio ? transportFields.cwd.trim() || null : null,
    auth:
      authOverride
      ?? (authKind === "oauth2"
        ? connectedOauthAuth ?? (() => {
            throw new Error("Complete MCP OAuth before saving.");
          })()
        : { kind: "none" }),
  });

  const hasConnectedOauth =
    oauthConnectionKey !== null
    && oauthConnectionKey === remoteConfigKey
    && oauthAuth !== null;
  const isDerivingSource = !isStdio && remoteConfigKey !== null && remoteConfigKey !== lastDiscoveryKey;
  const shouldCreateWithoutSigningIn = detectedOauthRequired && !hasConnectedOauth;
  const submitButtonLabel =
    isDerivingSource
      ? "Checking source..."
      : props.mode === "create" && shouldCreateWithoutSigningIn
        ? "Create source without signing in"
        : submitMutation.status === "pending"
          ? props.mode === "create"
            ? "Creating..."
            : "Saving..."
          : props.mode === "create"
            ? "Create Source"
            : "Save Changes";
  const submitButtonClassName =
    props.mode === "create" && shouldCreateWithoutSigningIn
      ? "border-amber-500/30 bg-amber-500/12 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
      : undefined;

  return (
    <div className="space-y-8">
      <div className="space-y-6 rounded-lg border border-border bg-card p-6 text-sm ring-1 ring-foreground/[0.04]">
        <div className="grid gap-2">
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="grid gap-2">
          <Label>Icon URL</Label>
          <Input
            value={iconUrl}
            onChange={(event) => setIconUrl(event.target.value)}
            placeholder="https://cdn.example.com/icon.png"
            className="font-mono text-xs"
          />
          {resolvedIconUrl && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <img src={resolvedIconUrl} alt="" className="size-4 rounded-sm object-contain" />
              <span>{iconUrl.trim() ? "Using override" : "Auto preview"}</span>
            </div>
          )}
        </div>

        <div className="grid gap-2">
          <Label>Transport</Label>
          <Select
            value={transportFields.transport}
            onChange={(event) => {
              const nextTransport = event.target.value as McpTransportValue;
              setTransportFields((current) =>
                setMcpTransportFieldsTransport(current, nextTransport)
              );
              if (nextTransport === "stdio") {
                setAuthKind("none");
                setOauthAuth(null);
                setOauthStatus("idle");
                setOauthConnectionKey(null);
              }
            }}
          >
            <option value="">Auto (remote)</option>
            <option value="auto">Auto</option>
            <option value="streamable-http">Streamable HTTP</option>
            <option value="sse">SSE</option>
            <option value="stdio">stdio</option>
          </Select>
        </div>

        {isStdio ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2 md:col-span-2">
              <Label>Command</Label>
              <Input
                value={transportFields.command}
                onChange={(event) =>
                  setTransportFields({
                    ...transportFields,
                    command: event.target.value,
                  })}
                className="font-mono text-xs"
              />
            </div>

            <div className="grid gap-2">
              <Label>Args</Label>
              <Textarea
                value={transportFields.argsText}
                onChange={(event) =>
                  setTransportFields({
                    ...transportFields,
                    argsText: event.target.value,
                  })}
                rows={3}
                placeholder='["server.js","--port","8787"]'
              />
            </div>

            <div className="grid gap-2">
              <Label>Environment</Label>
              <Textarea
                value={transportFields.envText}
                onChange={(event) =>
                  setTransportFields({
                    ...transportFields,
                    envText: event.target.value,
                  })}
                rows={3}
                placeholder='{"NODE_ENV":"production"}'
              />
            </div>

            <div className="grid gap-2 md:col-span-2">
              <Label>Working Directory</Label>
              <Input
                value={transportFields.cwd}
                onChange={(event) =>
                  setTransportFields({
                    ...transportFields,
                    cwd: event.target.value,
                  })}
                className="font-mono text-xs"
              />
            </div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2 md:col-span-2">
              <Label>Endpoint</Label>
              <Input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                className="font-mono text-xs"
              />
            </div>

            <div className="grid gap-2">
              <Label>Query Params</Label>
              <Textarea
                value={transportFields.queryParamsText}
                onChange={(event) =>
                  setTransportFields({
                    ...transportFields,
                    queryParamsText: event.target.value,
                  })}
                rows={3}
                placeholder='{"transport":"streamable-http"}'
              />
            </div>

            <div className="grid gap-2">
              <Label>Headers</Label>
              <Textarea
                value={transportFields.headersText}
                onChange={(event) =>
                  setTransportFields({
                    ...transportFields,
                    headersText: event.target.value,
                  })}
                rows={3}
                placeholder='{"x-api-key":"..."}'
              />
            </div>
          </div>
        )}

        {!isStdio && (
          <div className="grid gap-2">
            <Label>Auth</Label>
            <Select
              value={authKind}
              onChange={(event) => {
                const nextKind = event.target.value as McpConnectionAuth["kind"];
                setAuthKind(nextKind);
                if (nextKind !== "oauth2") {
                  setOauthAuth(null);
                  setOauthStatus("idle");
                  setOauthConnectionKey(null);
                }
              }}
            >
              <option value="none">None</option>
              <option value="oauth2">OAuth 2.0</option>
            </Select>
          </div>
        )}

        {!isStdio && authKind === "oauth2" && (
          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">OAuth</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {detectedOauthRequired
                    ? "This MCP server requires OAuth before it can be connected."
                    : "Authenticate with the MCP server's built-in OAuth flow."}
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  setError(null);
                  setOauthStatus("pending");
                  void runOauth()
                    .catch((cause) => {
                      setOauthStatus("idle");
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                    });
                }}
              >
                {oauthStatus === "connected" ? "Reconnect OAuth" : "Connect OAuth"}
              </Button>
            </div>
            {oauthStatus === "connected" && (
              <div className="mt-3 text-xs text-primary">
                Connected
              </div>
            )}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            {error}
          </Alert>
        )}

        <div className="flex items-center justify-end gap-3">
          <Button
            onClick={() => {
              setError(null);
              void (async () => {
                try {
                  if (isDerivingSource) {
                    return;
                  }

                  await submitMutation.mutateAsync(
                    buildInput(
                      hasConnectedOauth ? oauthAuth : null,
                      shouldCreateWithoutSigningIn ? { kind: "none" } : undefined,
                    ),
                  );
                } catch (cause: unknown) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                }
              })();
            }}
            disabled={submitMutation.status === "pending" || isDerivingSource}
            className={submitButtonClassName}
          >
            {isDerivingSource && <IconSpinner className="size-3.5" />}
            {submitButtonLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function McpAddPage() {
  const navigation = useSourcePluginNavigation();
  const initialValue = mcpInputFromSearch(useSourcePluginSearch());
  const installation = useLocalInstallation();
  const client = getMcpHttpClient();
  const createSource = useAtomSet(
    client.mutation("mcp", "createSource"),
    { mode: "promise" },
  );

  if (installation.status !== "ready") {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl tracking-tight text-foreground">
            Add MCP Source
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            Connect a Model Context Protocol server and import its tools.
          </p>
        </div>

        <McpSourceForm
          initialValue={initialValue}
          mode="create"
          onSubmit={async (input) => {
            const source = await createSource({
              path: {
                workspaceId: installation.data.scopeId,
              },
              payload: input,
              reactivityKeys: {
                sources: [installation.data.scopeId],
              },
            });

            startTransition(() => {
              void navigation.detail(source.id, {
                tab: "model",
              });
            });
          }}
        />
      </div>
    </div>
  );
}

export function McpEditPage(props: {
  source: Source;
}) {
  const navigation = useSourcePluginNavigation();
  const installation = useLocalInstallation();
  const client = getMcpHttpClient();
  const configResult = useAtomValue(
    installation.status === "ready"
      ? client.query("mcp", "getSourceConfig", {
          path: {
            workspaceId: installation.data.scopeId,
            sourceId: props.source.id,
          },
          reactivityKeys: {
            source: [installation.data.scopeId, props.source.id],
          },
          timeToLive: "30 seconds",
        })
      : client.query("local", "installation", {
          timeToLive: "1 second",
        }) as never,
  );
  const updateSource = useAtomSet(
    client.mutation("mcp", "updateSource"),
    { mode: "promise" },
  );

  if (installation.status !== "ready") {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

  if (Result.isFailure(configResult)) {
    return (
      <Alert variant="destructive">
        Failed loading source configuration.
      </Alert>
    );
  }

  if (!Result.isSuccess(configResult)) {
    return <div className="text-sm text-muted-foreground">Loading configuration...</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl tracking-tight text-foreground">
            Edit MCP Source
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            Update the connection settings for {props.source.name}.
          </p>
        </div>

        <McpSourceForm
          initialValue={configResult.value}
          mode="edit"
          onSubmit={async (input) => {
            const source = await updateSource({
              path: {
                workspaceId: installation.data.scopeId,
                sourceId: props.source.id,
              },
              payload: input,
              reactivityKeys: {
                sources: [installation.data.scopeId],
                source: [installation.data.scopeId, props.source.id],
                sourceInspection: [installation.data.scopeId, props.source.id],
                sourceInspectionTool: [installation.data.scopeId, props.source.id],
                sourceDiscovery: [installation.data.scopeId, props.source.id],
              },
            });

            startTransition(() => {
              void navigation.detail(source.id, {
                tab: "model",
              });
            });
          }}
        />
      </div>
    </div>
  );
}

export function McpDetailPage(props: {
  source: Source;
}) {
  const navigation = useSourcePluginNavigation();
  const search = parseSourceToolExplorerSearch(
    useSourcePluginSearch(),
  ) satisfies SourceToolExplorerSearch;
  const installation = useLocalInstallation();
  const client = getMcpHttpClient();
  const removeSource = useAtomSet(
    client.mutation("mcp", "removeSource"),
    { mode: "promise" },
  );
  const refreshSource = useAtomSet(
    client.mutation("mcp", "refreshSource"),
    { mode: "promise" },
  );
  const refreshMutation = useExecutorMutation<Source["id"], Source>(async (sourceId) =>
    refreshSource({
      path: {
        workspaceId: props.source.scopeId,
        sourceId,
      },
      reactivityKeys: {
        sources: [props.source.scopeId],
        source: [props.source.scopeId, sourceId],
        sourceInspection: [props.source.scopeId, sourceId],
        sourceInspectionTool: [props.source.scopeId, sourceId],
        sourceDiscovery: [props.source.scopeId, sourceId],
      },
    })
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const configResult = useAtomValue(
    installation.status === "ready"
      ? client.query("mcp", "getSourceConfig", {
          path: {
            workspaceId: installation.data.scopeId,
            sourceId: props.source.id,
          },
          reactivityKeys: {
            source: [installation.data.scopeId, props.source.id],
          },
          timeToLive: "30 seconds",
        })
      : client.query("local", "installation", {
          timeToLive: "1 second",
        }) as never,
  );
  const summary = useMemo(() => {
    if (!Result.isSuccess(configResult)) {
      return null;
    }

    const config = configResult.value;
    const location = config.transport === "stdio"
      ? config.command ?? "stdio"
      : config.endpoint ?? "remote";

    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono text-foreground">{location}</span>
        <Badge variant="muted">Transport: {config.transport ?? "auto"}</Badge>
        <Badge variant="muted">Auth: {config.auth.kind}</Badge>
      </div>
    );
  }, [configResult]);

  if (installation.status !== "ready") {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

  const handleDelete = async () => {
    if (isDeleting) {
      return;
    }

    setIsDeleting(true);
    try {
      await removeSource({
        path: {
          workspaceId: installation.data.scopeId,
          sourceId: props.source.id,
        },
        reactivityKeys: {
          sources: [installation.data.scopeId],
          source: [installation.data.scopeId, props.source.id],
          sourceInspection: [installation.data.scopeId, props.source.id],
          sourceInspectionTool: [installation.data.scopeId, props.source.id],
          sourceDiscovery: [installation.data.scopeId, props.source.id],
        },
      });
      startTransition(() => {
        void navigation.home();
      });
    } finally {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <SourceToolExplorer
      sourceId={props.source.id}
      title={props.source.name}
      kind={props.source.kind}
      search={search}
      navigate={(next) => navigation.updateSearch(next)}
      summary={summary}
      actions={(
        <>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              void refreshMutation.mutateAsync(props.source.id);
            }}
            disabled={refreshMutation.status === "pending"}
          >
            {refreshMutation.status === "pending" ? "Refreshing..." : "Refresh"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() =>
              void navigation.edit(props.source.id)}
          >
            <IconPencil className="size-3.5" />
            Edit
          </Button>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-destructive">
                Confirm delete?
              </span>
              <Button
                variant="outline"
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive-outline"
                onClick={() => {
                  void handleDelete().catch(() => {});
                }}
                disabled={isDeleting}
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </Button>
            </div>
          ) : (
            <Button
              variant="destructive-outline"
              onClick={() => setConfirmDelete(true)}
              disabled={isDeleting}
            >
              Delete
            </Button>
          )}
        </>
      )}
    />
  );
}

function McpSourceRoute(props: {
  children: (source: Source) => ReactNode;
}) {
  const params = useSourcePluginRouteParams<{ sourceId?: string }>();
  const sourceId = typeof params.sourceId === "string" ? params.sourceId : null;
  const source = useSource(sourceId ?? "");

  if (sourceId === null || source.status === "error") {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        This MCP source is unavailable.
      </div>
    );
  }

  if (source.status === "loading") {
    return (
      <div className="px-6 py-8 text-sm text-muted-foreground">
        Loading source...
      </div>
    );
  }

  if (source.data.kind !== "mcp") {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        Expected an `mcp` source, but received `{source.data.kind}`.
      </div>
    );
  }

  return props.children(source.data);
}

export function McpEditRoute() {
  return (
    <McpSourceRoute>
      {(source) => <McpEditPage source={source} />}
    </McpSourceRoute>
  );
}

export function McpDetailRoute() {
  return (
    <McpSourceRoute>
      {(source) => <McpDetailPage source={source} />}
    </McpSourceRoute>
  );
}

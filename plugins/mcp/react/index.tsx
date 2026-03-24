import { startTransition, useMemo, useState } from "react";
import type { Source } from "@executor/react";
import {
  Result,
  defineExecutorPluginHttpApiClient,
  useAtomSet,
  useAtomValue,
  useExecutorMutation,
  useLocalInstallation,
} from "@executor/react";
import {
  IconPencil,
  SourceToolExplorer,
  defineExecutorFrontendPlugin,
  defineFrontendSourceType,
  parseSourceToolExplorerSearch,
  type SourceToolExplorerSearch,
  useSourcePluginNavigation,
  useSourcePluginSearch,
} from "@executor/react/source-plugins";

import {
  mcpHttpApiExtension,
} from "@executor/plugin-mcp-http";
import {
  type McpConnectInput,
  type McpConnectionAuth,
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

const OAUTH_STORAGE_PREFIX = "executor:mcp-oauth:";
const OAUTH_TIMEOUT_MS = 2 * 60_000;

const getMcpHttpClient = defineExecutorPluginHttpApiClient<"McpReactHttpClient">()(
  "McpReactHttpClient",
  [mcpHttpApiExtension] as const,
);

const defaultMcpInput = (): McpConnectInput => ({
  name: "My MCP Source",
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

function McpSourceForm(props: {
  initialValue: McpConnectInput;
  mode: "create" | "edit";
  onSubmit: (input: McpConnectInput) => Promise<void>;
}) {
  const installation = useLocalInstallation();
  const client = getMcpHttpClient();
  const startOAuth = useAtomSet(
    client.mutation("mcp", "startOAuth"),
    { mode: "promise" },
  );
  const submitMutation = useExecutorMutation<McpConnectInput, void>(props.onSubmit);
  const [name, setName] = useState(props.initialValue.name);
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
  const [error, setError] = useState<string | null>(null);

  const isStdio = transportFields.transport === "stdio";

  const runOauth = async () => {
    if (installation.status !== "ready") {
      throw new Error("Workspace is still loading.");
    }
    if (isStdio) {
      throw new Error("MCP OAuth is only available for remote MCP transports.");
    }

    const payload: McpStartOAuthInput = {
      endpoint: endpoint.trim(),
      queryParams: parseJsonStringMap("Query params", transportFields.queryParamsText),
      redirectUrl: new URL(
        "/v1/plugins/mcp/oauth/callback",
        window.location.origin,
      ).toString(),
    };

    const started = await startOAuth({
      path: {
        workspaceId: installation.data.scopeId,
      },
      payload,
    });

    const popup = window.open(
      started.authorizationUrl,
      "executor-mcp-oauth",
      "width=560,height=760,noopener,noreferrer",
    );
    if (!popup) {
      throw new Error("Failed opening MCP OAuth popup.");
    }

    const result = await waitForOauthPopupResult(started.sessionId);
    if (!result.ok) {
      throw new Error(result.error);
    }

    setOauthAuth(result.auth);
    setOauthStatus("connected");
  };

  const buildInput = (): McpConnectInput => ({
    name: name.trim(),
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
      authKind === "oauth2"
        ? oauthAuth ?? (() => {
            throw new Error("Complete MCP OAuth before saving.");
          })()
        : { kind: "none" },
  });

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {props.mode === "create" ? "Connect MCP Source" : "Edit MCP Source"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          MCP now owns its transport config, OAuth flow, and tool surface inside the plugin.
        </p>
      </div>

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Transport</span>
        <select
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
            }
          }}
          className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
        >
          <option value="">Auto (remote)</option>
          <option value="auto">Auto</option>
          <option value="streamable-http">Streamable HTTP</option>
          <option value="sse">SSE</option>
          <option value="stdio">stdio</option>
        </select>
      </label>

      {isStdio ? (
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-1.5 md:col-span-2">
            <span className="text-xs font-medium text-foreground">Command</span>
            <input
              value={transportFields.command}
              onChange={(event) =>
                setTransportFields({
                  ...transportFields,
                  command: event.target.value,
                })}
              className="h-10 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Args</span>
            <textarea
              value={transportFields.argsText}
              onChange={(event) =>
                setTransportFields({
                  ...transportFields,
                  argsText: event.target.value,
                })}
              rows={4}
              placeholder='["server.js","--port","8787"]'
              className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Environment</span>
            <textarea
              value={transportFields.envText}
              onChange={(event) =>
                setTransportFields({
                  ...transportFields,
                  envText: event.target.value,
                })}
              rows={4}
              placeholder='{"NODE_ENV":"production"}'
              className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-1.5 md:col-span-2">
            <span className="text-xs font-medium text-foreground">Working Directory</span>
            <input
              value={transportFields.cwd}
              onChange={(event) =>
                setTransportFields({
                  ...transportFields,
                  cwd: event.target.value,
                })}
              className="h-10 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-1.5 md:col-span-2">
            <span className="text-xs font-medium text-foreground">Endpoint</span>
            <input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              className="h-10 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Query Params</span>
            <textarea
              value={transportFields.queryParamsText}
              onChange={(event) =>
                setTransportFields({
                  ...transportFields,
                  queryParamsText: event.target.value,
                })}
              rows={4}
              placeholder='{"transport":"streamable-http"}'
              className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Headers</span>
            <textarea
              value={transportFields.headersText}
              onChange={(event) =>
                setTransportFields({
                  ...transportFields,
                  headersText: event.target.value,
                })}
              rows={4}
              placeholder='{"x-api-key":"..."}'
              className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
            />
          </label>
        </div>
      )}

      {!isStdio && (
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Auth</span>
          <select
            value={authKind}
            onChange={(event) => {
              const nextKind = event.target.value as McpConnectionAuth["kind"];
              setAuthKind(nextKind);
              if (nextKind !== "oauth2") {
                setOauthAuth(null);
                setOauthStatus("idle");
              }
            }}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/25"
          >
            <option value="none">None</option>
            <option value="oauth2">OAuth 2.0</option>
          </select>
        </label>
      )}

      {!isStdio && authKind === "oauth2" && (
        <div className="rounded-xl border border-border/70 bg-muted/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-foreground">
                MCP OAuth
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Authenticate directly against the MCP server and keep the token refs in plugin storage.
              </div>
            </div>
            <button
              type="button"
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
              className="inline-flex h-9 items-center rounded-lg border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
            >
              {oauthStatus === "connected" ? "Reconnect OAuth" : "Connect OAuth"}
            </button>
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            Status: <span className="text-foreground">{oauthStatus}</span>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => {
            setError(null);
            void submitMutation
              .mutateAsync(buildInput())
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : String(cause))
              );
          }}
          disabled={submitMutation.status === "pending"}
          className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {submitMutation.status === "pending"
            ? props.mode === "create"
              ? "Creating..."
              : "Saving..."
            : props.mode === "create"
              ? "Create Source"
              : "Save Changes"}
        </button>
      </div>
    </div>
  );
}

function McpAddPage() {
  const navigation = useSourcePluginNavigation();
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
    <McpSourceForm
      initialValue={defaultMcpInput()}
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
  );
}

function McpEditPage(props: {
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
      <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
        Failed loading MCP config.
      </div>
    );
  }

  if (!Result.isSuccess(configResult)) {
    return <div className="text-sm text-muted-foreground">Loading MCP config...</div>;
  }

  return (
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
  );
}

function McpDetailPage(props: {
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
      <div className="space-y-1">
        <div className="font-mono text-xs text-foreground">{location}</div>
        <div>
          Transport: <span className="text-foreground">{config.transport ?? "auto"}</span>
        </div>
        <div>
          Auth: <span className="text-foreground">{config.auth.kind}</span>
        </div>
      </div>
    );
  }, [configResult]);

  if (installation.status !== "ready") {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

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
          <button
            type="button"
            onClick={() =>
              void navigation.edit(props.source.id)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
          >
            <IconPencil className="size-3.5" />
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              const confirmed = window.confirm(`Delete MCP source "${props.source.name}"?`);
              if (!confirmed) {
                return;
              }

              void removeSource({
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
              }).then(() => {
                startTransition(() => {
                  void navigation.home();
                });
              });
            }}
            className="inline-flex h-9 items-center rounded-lg border border-destructive/25 bg-destructive/5 px-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            Delete
          </button>
        </>
      )}
    />
  );
}

const mcpSourceType = defineFrontendSourceType({
  key: "mcp",
  kind: "mcp",
  displayName: "MCP",
  description: "Connect remote or local MCP servers with plugin-owned OAuth.",
  renderAddPage: McpAddPage,
  renderEditPage: McpEditPage,
  renderDetailPage: McpDetailPage,
});

export const McpReactPlugin = defineExecutorFrontendPlugin({
  key: "mcp",
  sourceTypes: [mcpSourceType],
});

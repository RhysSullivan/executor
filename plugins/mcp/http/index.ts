import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpServerResponse,
} from "@effect/platform";
import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  type ExecutorHttpApiExtension,
  type ExecutorHttpPlugin,
} from "@executor/platform-api";
import { resolveRequestedLocalWorkspace } from "@executor/platform-api/local-context";
import {
  ScopeIdSchema,
  SourceIdSchema,
  SourceSchema,
  type Source,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  McpConnectInputSchema,
  McpDiscoverInputSchema,
  McpDiscoverResultSchema,
  McpSourceConfigPayloadSchema,
  McpStartOAuthInputSchema,
  McpStartOAuthResultSchema,
  type McpConnectInput,
  type McpDiscoverInput,
  type McpDiscoverResult,
  type McpOAuthPopupResult,
  type McpSourceConfigPayload,
  type McpStartOAuthInput,
  type McpStartOAuthResult,
  type McpUpdateSourceInput,
} from "@executor/plugin-mcp-shared";

type McpExecutorExtension = {
  mcp: {
    createSource: (
      input: McpConnectInput,
    ) => Effect.Effect<Source, Error>;
    getSourceConfig: (
      sourceId: Source["id"],
    ) => Effect.Effect<McpSourceConfigPayload, Error>;
    discoverSource: (
      input: McpDiscoverInput,
    ) => Effect.Effect<McpDiscoverResult, Error>;
    updateSource: (
      input: McpUpdateSourceInput,
    ) => Effect.Effect<Source, Error>;
    removeSource: (
      sourceId: Source["id"],
    ) => Effect.Effect<boolean, Error>;
    startOAuth: (
      input: McpStartOAuthInput,
    ) => Effect.Effect<McpStartOAuthResult, Error>;
    completeOAuth: (input: {
      state: string;
      code?: string;
      error?: string;
      errorDescription?: string;
    }) => Effect.Effect<Extract<McpOAuthPopupResult, { ok: true }>, Error>;
  };
};

const workspaceIdParam = HttpApiSchema.param("workspaceId", ScopeIdSchema);
const sourceIdParam = HttpApiSchema.param("sourceId", SourceIdSchema);
const htmlSchema = HttpApiSchema.Text({
  contentType: "text/html",
});

const callbackParamsSchema = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

export const McpHttpGroup = HttpApiGroup.make("mcp")
  .add(
    HttpApiEndpoint.post("createSource")`/workspaces/${workspaceIdParam}/plugins/mcp/sources`
      .setPayload(McpConnectInputSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("discoverSource")`/workspaces/${workspaceIdParam}/plugins/mcp/discover`
      .setPayload(McpDiscoverInputSchema)
      .addSuccess(McpDiscoverResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("getSourceConfig")`/workspaces/${workspaceIdParam}/plugins/mcp/sources/${sourceIdParam}`
      .addSuccess(McpSourceConfigPayloadSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.put("updateSource")`/workspaces/${workspaceIdParam}/plugins/mcp/sources/${sourceIdParam}`
      .setPayload(McpSourceConfigPayloadSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("removeSource")`/workspaces/${workspaceIdParam}/plugins/mcp/sources/${sourceIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("startOAuth")`/workspaces/${workspaceIdParam}/plugins/mcp/oauth/start`
      .setPayload(McpStartOAuthInputSchema)
      .addSuccess(McpStartOAuthResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("oauthCallback")`/plugins/mcp/oauth/callback`
      .setUrlParams(callbackParamsSchema)
      .addSuccess(htmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1");

export const mcpHttpApiExtension = {
  key: "mcp",
  group: McpHttpGroup,
} satisfies ExecutorHttpApiExtension<typeof McpHttpGroup>;

const McpHttpApi = HttpApi.make("executor").add(McpHttpGroup);

const toStorageError = (operation: string, cause: unknown) =>
  new ControlPlaneStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    details: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });

const toNotFoundError = (operation: string, cause: unknown) =>
  new ControlPlaneNotFoundError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    details: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });

const mapPluginStorageError = (operation: string, cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("not found") || message.includes("Not found")) {
    return toNotFoundError(operation, cause);
  }

  return toStorageError(operation, cause);
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const popupDocument = (payload: McpOAuthPopupResult): string => {
  const serialized = JSON.stringify(payload)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  const title = payload.ok ? "Connected" : "Connection failed";
  const message = payload.ok
    ? "Authentication complete. This window will close automatically."
    : payload.error;
  const statusColor = payload.ok ? "#22c55e" : "#ef4444";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fafafa; color: #111;">
    <style>@media (prefers-color-scheme: dark) { body { background: #09090b !important; color: #fafafa !important; } p { color: #a1a1aa !important; } }</style>
    <main style="text-align: center; max-width: 360px; padding: 24px;">
      <div style="width: 40px; height: 40px; border-radius: 50%; background: ${statusColor}; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center;">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          ${payload.ok
            ? '<path d="M6 10l3 3 5-6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
            : '<path d="M7 7l6 6M13 7l-6 6" stroke="white" stroke-width="2" stroke-linecap="round"/>'}
        </svg>
      </div>
      <h1 style="margin: 0 0 8px; font-size: 18px; font-weight: 600;">${escapeHtml(title)}</h1>
      <p style="margin: 0; font-size: 14px; color: #666; line-height: 1.5;">${escapeHtml(message)}</p>
    </main>
    <script>
      (() => {
        const payload = ${serialized};
        try {
          window.localStorage.setItem("executor:mcp-oauth:" + (payload.ok ? payload.sessionId : "failed"), JSON.stringify(payload));
        } catch {}
        try {
          if (window.opener) {
            window.opener.postMessage(payload, window.location.origin);
          }
        } finally {
          window.setTimeout(() => window.close(), 120);
        }
      })();
    </script>
  </body>
</html>`;
};

export const mcpHttpPlugin = (): ExecutorHttpPlugin<
  typeof McpHttpGroup,
  McpExecutorExtension
> => ({
  key: "mcp",
  group: McpHttpGroup,
  build: ({ executor }) =>
    HttpApiBuilder.group(McpHttpApi, "mcp", (handlers) =>
      handlers
        .handle("createSource", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "mcp.createSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.mcp.createSource(payload)),
            Effect.mapError((cause) => toStorageError("mcp.createSource", cause)),
          )
        )
        .handle("discoverSource", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "mcp.discoverSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.mcp.discoverSource(payload)),
            Effect.mapError((cause) => toStorageError("mcp.discoverSource", cause)),
          )
        )
        .handle("getSourceConfig", ({ path }) =>
          resolveRequestedLocalWorkspace(
            "mcp.getSourceConfig",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.mcp.getSourceConfig(path.sourceId)),
            Effect.mapError((cause) =>
              mapPluginStorageError("mcp.getSourceConfig", cause)
            ),
          )
        )
        .handle("updateSource", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "mcp.updateSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() =>
              executor.mcp.updateSource({
                sourceId: path.sourceId,
                config: payload,
              })
            ),
            Effect.mapError((cause) =>
              mapPluginStorageError("mcp.updateSource", cause)
            ),
          )
        )
        .handle("removeSource", ({ path }) =>
          resolveRequestedLocalWorkspace(
            "mcp.removeSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.mcp.removeSource(path.sourceId)),
            Effect.map((removed) => ({ removed })),
            Effect.mapError((cause) =>
              mapPluginStorageError("mcp.removeSource", cause)
            ),
          )
        )
        .handle("startOAuth", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "mcp.startOAuth",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.mcp.startOAuth(payload)),
            Effect.mapError((cause) => toStorageError("mcp.startOAuth", cause)),
          )
        )
        .handle("oauthCallback", ({ urlParams }) =>
          executor.mcp.completeOAuth({
            state: urlParams.state,
            code: urlParams.code,
            error: urlParams.error,
            errorDescription: urlParams.error_description,
          }).pipe(
            Effect.map((payload) => popupDocument(payload)),
            Effect.mapError((cause) =>
              toStorageError("mcp.oauthCallback", cause)
            ),
            Effect.catchAll((error) =>
              Effect.succeed(
                popupDocument({
                  type: "executor:oauth-result",
                  ok: false,
                  sessionId: null,
                  error: error.message,
                }),
              )
            ),
            Effect.flatMap((html) => HttpServerResponse.html(html)),
          )
        )
    ),
});

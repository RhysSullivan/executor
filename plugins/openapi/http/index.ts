import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpServerResponse,
} from "@effect/platform";
import {
  ControlPlaneNotFoundError,
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
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
  OpenApiConnectInputSchema,
  OpenApiOAuthPopupResultSchema,
  OpenApiPreviewRequestSchema,
  OpenApiPreviewResponseSchema,
  OpenApiSourceConfigPayloadSchema,
  OpenApiStartOAuthInputSchema,
  OpenApiStartOAuthResultSchema,
  OpenApiUpdateSourceInputSchema,
  type OpenApiConnectInput,
  type OpenApiOAuthPopupResult,
  type OpenApiPreviewRequest,
  type OpenApiPreviewResponse,
  type OpenApiSourceConfigPayload,
  type OpenApiStartOAuthInput,
  type OpenApiStartOAuthResult,
  type OpenApiUpdateSourceInput,
} from "@executor/plugin-openapi-shared";

type OpenApiExecutorExtension = {
  openapi: {
    previewDocument: (
      input: OpenApiPreviewRequest,
    ) => Effect.Effect<OpenApiPreviewResponse, Error, never>;
    createSource: (
      input: OpenApiConnectInput,
    ) => Effect.Effect<Source, Error, never>;
    getSourceConfig: (
      sourceId: Source["id"],
    ) => Effect.Effect<OpenApiSourceConfigPayload, Error, never>;
    updateSource: (
      input: OpenApiUpdateSourceInput,
    ) => Effect.Effect<Source, Error, never>;
    removeSource: (
      sourceId: Source["id"],
    ) => Effect.Effect<boolean, Error, never>;
    startOAuth: (
      input: OpenApiStartOAuthInput,
    ) => Effect.Effect<OpenApiStartOAuthResult, Error, never>;
    completeOAuth: (input: {
      state: string;
      code?: string;
      error?: string;
      errorDescription?: string;
    }) => Effect.Effect<Extract<OpenApiOAuthPopupResult, { ok: true }>, Error, never>;
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

export const OpenApiHttpGroup = HttpApiGroup.make("openapi")
  .add(
    HttpApiEndpoint.post("previewDocument")`/workspaces/${workspaceIdParam}/plugins/openapi/preview`
      .setPayload(OpenApiPreviewRequestSchema)
      .addSuccess(OpenApiPreviewResponseSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("createSource")`/workspaces/${workspaceIdParam}/plugins/openapi/sources`
      .setPayload(OpenApiConnectInputSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("getSourceConfig")`/workspaces/${workspaceIdParam}/plugins/openapi/sources/${sourceIdParam}`
      .addSuccess(OpenApiSourceConfigPayloadSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.put("updateSource")`/workspaces/${workspaceIdParam}/plugins/openapi/sources/${sourceIdParam}`
      .setPayload(OpenApiSourceConfigPayloadSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("removeSource")`/workspaces/${workspaceIdParam}/plugins/openapi/sources/${sourceIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("startOAuth")`/workspaces/${workspaceIdParam}/plugins/openapi/oauth/start`
      .setPayload(OpenApiStartOAuthInputSchema)
      .addSuccess(OpenApiStartOAuthResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("oauthCallback")`/plugins/openapi/oauth/callback`
      .setUrlParams(callbackParamsSchema)
      .addSuccess(htmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1");

export const OpenApiHttpApi = HttpApi.make("executor").add(OpenApiHttpGroup);

export const openApiHttpApiExtension = {
  key: "openapi",
  group: OpenApiHttpGroup,
} satisfies ExecutorHttpApiExtension<typeof OpenApiHttpGroup>;

const messageFromCause = (cause: unknown): string => {
  if (cause instanceof Error && typeof cause.message === "string" && cause.message.length > 0) {
    return cause.message;
  }

  const rendered = String(cause);
  return rendered.length > 0 ? rendered : "Unknown error";
};

const detailsFromCause = (cause: unknown): string => {
  if (cause instanceof Error && typeof cause.stack === "string" && cause.stack.length > 0) {
    return cause.stack;
  }

  return messageFromCause(cause);
};

const toBadRequestError = (operation: string) => (cause: unknown) =>
  new ControlPlaneBadRequestError({
    operation,
    message: messageFromCause(cause),
    details: detailsFromCause(cause),
  });

const toStorageError = (operation: string) => (cause: unknown) =>
  new ControlPlaneStorageError({
    operation,
    message: messageFromCause(cause),
    details: detailsFromCause(cause),
  });

const toNotFoundError = (operation: string, cause: unknown) =>
  new ControlPlaneNotFoundError({
    operation,
    message: messageFromCause(cause),
    details: detailsFromCause(cause),
  });

const mapPluginStorageError = (operation: string) => (cause: unknown) => {
  const message = messageFromCause(cause);
  if (message.includes("not found") || message.includes("Not found")) {
    return toNotFoundError(operation, cause);
  }

  return toStorageError(operation)(cause);
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const popupDocument = (payload: OpenApiOAuthPopupResult): string => {
  const serialized = JSON.stringify(payload)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  const title = payload.ok ? "OpenAPI OAuth connected" : "OpenAPI OAuth failed";
  const message = payload.ok
    ? "OpenAPI credentials are ready. Return to the source form to finish saving."
    : payload.error;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
    <script>
      (() => {
        const payload = ${serialized};
        try {
          window.localStorage.setItem("executor:openapi-oauth:" + (payload.sessionId ?? "failed"), JSON.stringify(payload));
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

export const openApiHttpPlugin = (): ExecutorHttpPlugin<
  typeof OpenApiHttpGroup,
  OpenApiExecutorExtension
> => ({
  key: "openapi",
  group: OpenApiHttpGroup,
  build: ({ executor }) =>
    HttpApiBuilder.group(OpenApiHttpApi, "openapi", (handlers) =>
      handlers
        .handle("previewDocument", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "openapi.previewDocument",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.openapi.previewDocument(payload)),
            Effect.mapError(toBadRequestError("openapi.previewDocument")),
          )
        )
        .handle("createSource", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "openapi.createSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.openapi.createSource(payload)),
            Effect.mapError(toStorageError("openapi.createSource")),
          )
        )
        .handle("getSourceConfig", ({ path }) =>
          resolveRequestedLocalWorkspace(
            "openapi.getSourceConfig",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.openapi.getSourceConfig(path.sourceId)),
            Effect.mapError(mapPluginStorageError("openapi.getSourceConfig")),
          )
        )
        .handle("updateSource", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "openapi.updateSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() =>
              executor.openapi.updateSource({
                sourceId: path.sourceId,
                config: payload,
              })
            ),
            Effect.mapError(mapPluginStorageError("openapi.updateSource")),
          )
        )
        .handle("removeSource", ({ path }) =>
          resolveRequestedLocalWorkspace(
            "openapi.removeSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.openapi.removeSource(path.sourceId)),
            Effect.map((removed) => ({ removed })),
            Effect.mapError(mapPluginStorageError("openapi.removeSource")),
          )
        )
        .handle("startOAuth", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "openapi.startOAuth",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.openapi.startOAuth(payload)),
            Effect.mapError(toStorageError("openapi.startOAuth")),
          )
        )
        .handle("oauthCallback", ({ urlParams }) =>
          executor.openapi.completeOAuth({
            state: urlParams.state,
            code: urlParams.code,
            error: urlParams.error,
            errorDescription: urlParams.error_description,
          }).pipe(
            Effect.map((payload) => popupDocument(payload)),
            Effect.mapError(toStorageError("openapi.oauthCallback")),
            Effect.catchAll((error) =>
              Effect.succeed(
                popupDocument({
                  type: "executor:oauth-result",
                  ok: false,
                  sessionId: urlParams.state ?? null,
                  error: error.message,
                }),
              )
            ),
            Effect.flatMap((html) => HttpServerResponse.html(html)),
          )
        )
    ),
});

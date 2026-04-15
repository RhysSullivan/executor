import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Context, Effect } from "effect";

import { runOAuthCallback } from "@executor/plugin-oauth2/http";

import { addGroup } from "@executor/api";
import { OpenApiOAuthError } from "../sdk/errors";
import type {
  OpenApiPluginExtension,
  HeaderValue,
  OpenApiUpdateSourceInput,
} from "../sdk/plugin";
import { OAuth2Auth } from "../sdk/types";
import { OpenApiGroup } from "./group";

const OPENAPI_OAUTH_CHANNEL = "executor:openapi-oauth-result";

const toPopupErrorMessage = (error: unknown): string => {
  if (error instanceof OpenApiOAuthError) return error.message;
  return "Authentication failed";
};

// ---------------------------------------------------------------------------
// Service tag — the server provides the OpenAPI extension
// ---------------------------------------------------------------------------

export class OpenApiExtensionService extends Context.Tag("OpenApiExtensionService")<
  OpenApiExtensionService,
  OpenApiPluginExtension
>() {}

// ---------------------------------------------------------------------------
// Composed API — core + openapi group
// ---------------------------------------------------------------------------

const ExecutorApiWithOpenApi = addGroup(OpenApiGroup);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const OpenApiHandlers = HttpApiBuilder.group(ExecutorApiWithOpenApi, "openapi", (handlers) =>
  handlers
    .handle("previewSpec", ({ payload }) =>
      Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        return yield* ext.previewSpec(payload.spec);
      }).pipe(Effect.orDie),
    )
    .handle("addSpec", ({ payload }) =>
      Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        const result = yield* ext.addSpec({
          spec: payload.spec,
          name: payload.name,
          baseUrl: payload.baseUrl,
          namespace: payload.namespace,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
          oauth2: payload.oauth2,
        });
        return {
          toolCount: result.toolCount,
          namespace: payload.namespace ?? "api",
        };
      }).pipe(Effect.orDie),
    )
    .handle("getSource", ({ path }) =>
      Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        return yield* ext.getSource(path.namespace);
      }).pipe(Effect.orDie),
    )
    .handle("updateSource", ({ path, payload }) =>
      Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        yield* ext.updateSource(path.namespace, {
          name: payload.name,
          baseUrl: payload.baseUrl,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
        } as OpenApiUpdateSourceInput);
        return { updated: true };
      }).pipe(Effect.orDie),
    )
    .handle("startOAuth", ({ payload }) =>
      Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        return yield* ext.startOAuth({
          displayName: payload.displayName,
          securitySchemeName: payload.securitySchemeName,
          flow: payload.flow,
          authorizationUrl: payload.authorizationUrl,
          tokenUrl: payload.tokenUrl,
          redirectUrl: payload.redirectUrl,
          clientIdSecretId: payload.clientIdSecretId,
          clientSecretSecretId: payload.clientSecretSecretId ?? null,
          scopes: [...payload.scopes],
        });
      }),
    )
    .handle("completeOAuth", ({ payload }) =>
      Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        return yield* ext.completeOAuth({
          state: payload.state,
          code: payload.code,
          error: payload.error,
        });
      }),
    )
    .handle("oauthCallback", ({ urlParams }) =>
      Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        const html = yield* runOAuthCallback<OAuth2Auth, OpenApiOAuthError, never>({
          complete: ({ state, code, error }) =>
            ext.completeOAuth({
              state,
              code: code ?? undefined,
              error: error ?? undefined,
            }),
          urlParams,
          toErrorMessage: toPopupErrorMessage,
          channelName: OPENAPI_OAUTH_CHANNEL,
        });
        return yield* HttpServerResponse.html(html);
      }).pipe(Effect.orDie),
    ),
);

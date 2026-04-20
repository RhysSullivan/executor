import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Context, Effect } from "effect";

import { runOAuthCallback } from "@executor/plugin-oauth2/http";

import { addGroup, capture, InternalError } from "@executor/api";
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
// Service tag
//
// Holds the `Captured` shape — every method's `StorageFailure`
// channel has been swapped for `InternalError({ traceId })`. The cloud
// app provides an already-wrapped extension via
// `Layer.succeed(OpenApiExtensionService, withCapture(executor.openapi))`.
// Handlers see `InternalError` in the error union, which matches
// `.addError(InternalError)` on the group — no per-handler translation.
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
//
// Each handler is exactly: yield the extension service, call the method,
// return. Plugin SDK errors flow through the typed channel and are
// schema-encoded to 4xx by HttpApi (see group.ts `.addError(...)` calls).
// Defects bubble up and are captured + downgraded to `InternalError(traceId)`
// by the API-level observability middleware.
// ---------------------------------------------------------------------------

export const OpenApiHandlers = HttpApiBuilder.group(ExecutorApiWithOpenApi, "openapi", (handlers) =>
  handlers
    .handle("previewSpec", ({ payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        return yield* ext.previewSpec(payload.spec);
      })),
    )
    .handle("addSpec", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        const result = yield* ext.addSpec({
          spec: payload.spec,
          scope: path.scopeId,
          name: payload.name,
          baseUrl: payload.baseUrl,
          namespace: payload.namespace,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
          oauth2: payload.oauth2,
        });
        return {
          toolCount: result.toolCount,
          namespace: result.sourceId,
        };
      })),
    )
    .handle("getSource", ({ path }) =>
      capture(Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        return yield* ext.getSource(path.namespace, path.scopeId);
      })),
    )
    .handle("updateSource", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        yield* ext.updateSource(path.namespace, path.scopeId, {
          name: payload.name,
          baseUrl: payload.baseUrl,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
        } as OpenApiUpdateSourceInput);
        return { updated: true };
      })),
    )
    .handle("startOAuth", ({ payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        // No tokenScope → plugin defaults to ctx.scopes[0].id (innermost).
        // Single-scope executors: only scope in stack.
        // Stacked executors: per-user scope, so tokens shadow by id.
        const tokenScope = payload.tokenScope as string | undefined;
        if (payload.flow === "clientCredentials") {
          return yield* ext.startOAuth({
            flow: "clientCredentials",
            displayName: payload.displayName,
            securitySchemeName: payload.securitySchemeName,
            tokenUrl: payload.tokenUrl,
            clientIdSecretId: payload.clientIdSecretId,
            clientSecretSecretId: payload.clientSecretSecretId,
            scopes: [...payload.scopes],
            tokenScope,
            accessTokenSecretId: payload.accessTokenSecretId,
          });
        }
        return yield* ext.startOAuth({
          flow: "authorizationCode",
          displayName: payload.displayName,
          securitySchemeName: payload.securitySchemeName,
          authorizationUrl: payload.authorizationUrl,
          tokenUrl: payload.tokenUrl,
          redirectUrl: payload.redirectUrl,
          clientIdSecretId: payload.clientIdSecretId,
          clientSecretSecretId: payload.clientSecretSecretId ?? null,
          scopes: [...payload.scopes],
          tokenScope,
          accessTokenSecretId: payload.accessTokenSecretId,
          refreshTokenSecretId: payload.refreshTokenSecretId ?? null,
        });
      })),
    )
    .handle("completeOAuth", ({ payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        return yield* ext.completeOAuth({
          state: payload.state,
          code: payload.code,
          error: payload.error,
        });
      })),
    )
    .handle("oauthCallback", ({ urlParams }) =>
      // OAuth popup is special: it always returns 200 HTML and renders the
      // failure into the popup body so the parent window's listener gets a
      // structured result.
      capture(Effect.gen(function* () {
        const ext = yield* OpenApiExtensionService;
        const html = yield* runOAuthCallback<OAuth2Auth, OpenApiOAuthError | InternalError, never>({
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
      })),
    ),
);

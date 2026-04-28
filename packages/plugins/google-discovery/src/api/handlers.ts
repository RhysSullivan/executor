import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Context, Effect } from "effect";

import { runOAuthCallback } from "@executor/plugin-oauth2/http";

import { addGroup, capture } from "@executor/api";
import type {
  GoogleDiscoveryAddSourceInput,
  GoogleDiscoveryOAuthAuthResult,
  GoogleDiscoveryPluginExtension,
} from "../sdk/plugin";
import { GoogleDiscoveryOAuthError } from "../sdk/errors";
import { GoogleDiscoveryGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `Captured` shape — every method's `StorageFailure` channel
// has been swapped for `InternalError({ traceId })`. The host app
// provides an already-wrapped extension via
// `Layer.succeed(GoogleDiscoveryExtensionService, withCapture(executor.googleDiscovery))`.
// Handlers see `InternalError` in the error union, which matches
// `.addError(InternalError)` on the group — no per-handler translation.
// ---------------------------------------------------------------------------

export class GoogleDiscoveryExtensionService extends Context.Tag("GoogleDiscoveryExtensionService")<
  GoogleDiscoveryExtensionService,
  GoogleDiscoveryPluginExtension
>() {}

// ---------------------------------------------------------------------------
// Composed API
// ---------------------------------------------------------------------------

const ExecutorApiWithGoogleDiscovery = addGroup(GoogleDiscoveryGroup);

const GOOGLE_DISCOVERY_OAUTH_CHANNEL = "executor:google-discovery-oauth-result";

const toPopupErrorMessage = (error: unknown): string =>
  error instanceof GoogleDiscoveryOAuthError ? error.message : "Authentication failed";

// ---------------------------------------------------------------------------
// Handlers
//
// Each handler is exactly: yield the extension service, call the method,
// return. Plugin SDK errors flow through the typed channel and are
// schema-encoded to 4xx by HttpApi (see group.ts `.addError(...)` calls).
// `StorageFailure` has already been translated to `InternalError` by
// `withCapture` on the service instance; defects bubble up and are
// captured + downgraded to `InternalError(traceId)` by the API-level
// observability middleware.
//
// No `sanitize*`, no `liftDomainErrors`, no per-handler error mapping.
// If you find yourself adding error-handling here you're in the wrong layer.
// ---------------------------------------------------------------------------

export const GoogleDiscoveryHandlers = HttpApiBuilder.group(
  ExecutorApiWithGoogleDiscovery,
  "googleDiscovery",
  (handlers) =>
    handlers
      .handle("probeDiscovery", ({ payload }) =>
        capture(Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.probeDiscovery(payload.discoveryUrl);
        })),
      )
      .handle("addSource", ({ path, payload }) =>
        capture(Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.addSource({
            ...(payload as Omit<GoogleDiscoveryAddSourceInput, "scope">),
            scope: path.scopeId,
          });
        })),
      )
      .handle("startOAuth", ({ payload }) =>
        capture(Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.startOAuth({
            name: payload.name,
            discoveryUrl: payload.discoveryUrl,
            clientIdSecretId: payload.clientIdSecretId,
            clientSecretSecretId: payload.clientSecretSecretId,
            redirectUrl: payload.redirectUrl,
            scopes: payload.scopes,
            tokenScope: payload.tokenScope,
          });
        })),
      )
      .handle("completeOAuth", ({ payload }) =>
        capture(Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.completeOAuth({
            state: payload.state,
            code: payload.code,
            error: payload.error,
          });
        })),
      )
      .handle("getSource", ({ path }) =>
        capture(Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.getSource(path.namespace, path.scopeId);
        })),
      )
      .handle("updateSource", ({ path, payload }) =>
        capture(Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          yield* ext.updateSource(path.namespace, path.scopeId, {
            name: payload.name,
            auth: payload.auth,
          });
          return { updated: true };
        })),
      )
      .handle("oauthCallback", ({ urlParams }) =>
        capture(Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          const html = yield* runOAuthCallback<
            GoogleDiscoveryOAuthAuthResult,
            unknown,
            never
          >({
            complete: ({ state, code, error }) =>
              ext.completeOAuth({
                state,
                code: code ?? undefined,
                error: error ?? undefined,
              }),
            urlParams,
            toErrorMessage: toPopupErrorMessage,
            channelName: GOOGLE_DISCOVERY_OAUTH_CHANNEL,
          });
          return yield* HttpServerResponse.html(html);
        })),
      ),
);

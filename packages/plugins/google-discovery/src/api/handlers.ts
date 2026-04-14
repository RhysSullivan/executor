import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Cause, Context, Effect } from "effect";

import { runOAuthCallback } from "@executor/plugin-oauth2/http";

import { addGroup } from "@executor/api";
import type {
  GoogleDiscoveryAddSourceInput,
  GoogleDiscoveryOAuthAuthResult,
  GoogleDiscoveryPluginExtension,
} from "../sdk/plugin";
import {
  GoogleDiscoveryInvocationError,
  GoogleDiscoveryOAuthError,
  GoogleDiscoveryParseError,
  GoogleDiscoverySourceError,
} from "../sdk/errors";
import {
  GoogleDiscoveryApiError,
  GoogleDiscoveryGroup,
  GoogleDiscoveryInternalError,
} from "./group";

export class GoogleDiscoveryExtensionService extends Context.Tag("GoogleDiscoveryExtensionService")<
  GoogleDiscoveryExtensionService,
  GoogleDiscoveryPluginExtension
>() {}

const ExecutorApiWithGoogleDiscovery = addGroup(GoogleDiscoveryGroup);

const GOOGLE_DISCOVERY_OAUTH_CHANNEL = "executor:google-discovery-oauth-result";

const toPopupErrorMessage = (error: unknown): string => {
  if (error instanceof GoogleDiscoveryOAuthError) {
    return error.message;
  }
  return "Authentication failed";
};

const toGoogleDiscoveryApiError = (
  error: unknown,
): GoogleDiscoveryApiError | GoogleDiscoveryInternalError => {
  if (error instanceof GoogleDiscoveryApiError || error instanceof GoogleDiscoveryInternalError) {
    return error;
  }
  if (
    error instanceof GoogleDiscoveryParseError ||
    error instanceof GoogleDiscoverySourceError ||
    error instanceof GoogleDiscoveryOAuthError ||
    error instanceof GoogleDiscoveryInvocationError
  ) {
    return new GoogleDiscoveryApiError({ message: error.message });
  }
  return new GoogleDiscoveryInternalError({ message: "Internal server error" });
};

const sanitizeGoogleDiscoveryFailure = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, GoogleDiscoveryApiError | GoogleDiscoveryInternalError, R> =>
  Effect.catchAllCause(effect, (cause) =>
    Effect.fail(toGoogleDiscoveryApiError(Cause.squash(cause))),
  );

export const GoogleDiscoveryHandlers = HttpApiBuilder.group(
  ExecutorApiWithGoogleDiscovery,
  "googleDiscovery",
  (handlers) =>
    handlers
      .handle("probeDiscovery", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.probeDiscovery(payload.discoveryUrl);
        }).pipe(sanitizeGoogleDiscoveryFailure),
      )
      .handle("addSource", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.addSource(payload as GoogleDiscoveryAddSourceInput);
        }).pipe(sanitizeGoogleDiscoveryFailure),
      )
      .handle("startOAuth", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.startOAuth({
            name: payload.name,
            discoveryUrl: payload.discoveryUrl,
            clientIdSecretId: payload.clientIdSecretId,
            clientSecretSecretId: payload.clientSecretSecretId,
            redirectUrl: payload.redirectUrl,
            scopes: payload.scopes,
          });
        }).pipe(sanitizeGoogleDiscoveryFailure),
      )
      .handle("completeOAuth", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.completeOAuth({
            state: payload.state,
            code: payload.code,
            error: payload.error,
          });
        }).pipe(sanitizeGoogleDiscoveryFailure),
      )
      .handle("getSource", ({ path }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.getSource(path.namespace);
        }).pipe(sanitizeGoogleDiscoveryFailure),
      )
      .handle("oauthCallback", ({ urlParams }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          const html = yield* runOAuthCallback<
            GoogleDiscoveryOAuthAuthResult,
            GoogleDiscoveryOAuthError,
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
        }).pipe(sanitizeGoogleDiscoveryFailure),
      ),
);

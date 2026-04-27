// ---------------------------------------------------------------------------
// Shared OAuth HTTP handlers — thin forwarders over `executor.oauth.*`.
// Replaces the four per-plugin copies (mcp / openapi / google-discovery
// each had its own start / complete / callback handler).
// ---------------------------------------------------------------------------

import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";

import { runOAuthCallback } from "../oauth-popup";
import {
  OAUTH_POPUP_MESSAGE_TYPE,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthSessionNotFoundError,
  OAuthStartError,
  type OAuthStrategy,
} from "@executor/sdk";

import { ExecutorApi } from "../api";
import { capture } from "../observability";
import { ExecutorService } from "../services";

const OAUTH_POPUP_CHANNEL = OAUTH_POPUP_MESSAGE_TYPE;

const toPopupErrorMessage = (error: unknown): string => {
  if (error instanceof OAuthStartError) return error.message;
  if (error instanceof OAuthCompleteError) return error.message;
  if (error instanceof OAuthProbeError) return error.message;
  if (error instanceof OAuthSessionNotFoundError) {
    return `OAuth session not found: ${error.sessionId}`;
  }
  return "Authentication failed";
};

export const OAuthHandlers = HttpApiBuilder.group(ExecutorApi, "oauth", (handlers) =>
  handlers
    .handle("probe", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.oauth.probe({ endpoint: payload.endpoint });
        }),
      ),
    )
    .handle("start", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const tokenScope =
            payload.tokenScope ?? (executor.scopes[0]!.id as unknown as string);
          return yield* executor.oauth.start({
            endpoint: payload.endpoint,
            redirectUrl: payload.redirectUrl,
            connectionId: payload.connectionId,
            tokenScope,
            strategy: payload.strategy as OAuthStrategy,
            pluginId: payload.pluginId,
            identityLabel: payload.identityLabel,
          });
        }),
      ),
    )
    .handle("complete", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.oauth.complete({
            state: payload.state,
            code: payload.code,
            error: payload.error,
          });
        }),
      ),
    )
    .handle("cancel", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.oauth.cancel(payload.sessionId);
          return { cancelled: true };
        }),
      ),
    )
    .handle("callback", ({ urlParams }) =>
      // The callback always renders HTML, even on failure — the popup
      // shows the error + messages it back to the opener.
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const html = yield* runOAuthCallback({
            complete: ({ state, code, error }) =>
              executor.oauth.complete({
                state,
                code: code ?? undefined,
                error: error ?? undefined,
              }).pipe(
                Effect.tapErrorCause((cause) =>
                  Effect.logError("OAuth callback completion failed", cause),
                ),
                Effect.catchAllCause(() =>
                  Effect.fail(new Error("Authentication failed")),
                ),
              ),
            urlParams,
            toErrorMessage: toPopupErrorMessage,
            channelName: OAUTH_POPUP_CHANNEL,
          });
          return yield* HttpServerResponse.html(html);
        }),
      ),
    ),
);

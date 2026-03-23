import {
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import type { ScopeId as WorkspaceId } from "@executor/platform-sdk/schema";
import * as Cause from "effect/Cause";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ExecutorApi } from "../api";
import {
  ControlPlaneBadRequestError,
  ControlPlaneStorageError,
} from "../errors";
import {
  getControlPlaneExecutor,
  resolveRequestedLocalWorkspace,
} from "../local-context";
import {
  SourceOAuthPopupResultSchema,
  type SourceOAuthPopupResult,
} from "./api";

const OAUTH_RESULT_STORAGE_KEY_PREFIX = "executor:oauth-result:";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const serializeValueForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");

const encodeSourceOAuthPopupResultJson = Schema.encodeSync(
  Schema.parseJson(SourceOAuthPopupResultSchema),
);

const serializeJsonLiteralForScript = (value: string): string =>
  value
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");

const htmlResponse = (html: string, status = 200) =>
  HttpServerResponse.html(html).pipe(
    HttpServerResponse.setStatus(status),
  );

const readHeader = (headers: unknown, name: string): string | null => {
  if (headers instanceof Headers) {
    return headers.get(name);
  }

  if (headers && typeof headers === "object") {
    const record = headers as Record<string, unknown>;
    const direct = record[name];
    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }

    const lower = record[name.toLowerCase()];
    if (typeof lower === "string" && lower.length > 0) {
      return lower;
    }
  }

  return null;
};

const resolveRequestOrigin = (request: { url: string; headers: unknown }): string | null => {
  try {
    return new URL(request.url).origin;
  } catch {
    const forwardedHost = readHeader(request.headers, "x-forwarded-host");
    const host = forwardedHost ?? readHeader(request.headers, "host");
    if (!host) {
      return null;
    }

    const forwardedProto = readHeader(request.headers, "x-forwarded-proto");
    const protocol = forwardedProto && forwardedProto.length > 0 ? forwardedProto : "http";
    return `${protocol}://${host}`;
  }
};

const toStartSourceOAuthError = (input: {
  workspaceId: WorkspaceId;
  providerKey: string;
  cause: Cause.Cause<unknown>;
}) => {
  const pretty = Cause.pretty(input.cause);
  console.error("oauth.start_source_auth failed", {
    workspaceId: input.workspaceId,
    providerKey: input.providerKey,
    pretty,
  });

  if (pretty.includes("Invalid URL") || pretty.includes("required")) {
    return new ControlPlaneBadRequestError({
      operation: "oauth.start_source_auth",
      message: pretty,
      details: pretty,
    });
  }

  return new ControlPlaneStorageError({
    operation: "oauth.start_source_auth",
    message: pretty,
    details: pretty,
  });
};

const sourceOAuthPopupResultDocument = (input: {
  title: string;
  message: string;
  status: "connected" | "failed";
  sessionId: string;
  payload: SourceOAuthPopupResult;
}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        --bg: #fafaf9;
        --surface: #ffffff;
        --text: #1c1917;
        --text-secondary: #78716c;
        --border: #e7e5e4;
        --green: #16a34a;
        --green-light: #f0fdf4;
        --green-border: #bbf7d0;
        --red: #dc2626;
        --red-light: #fef2f2;
        --red-border: #fecaca;
      }

      * { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg);
        color: var(--text);
        font-family: system-ui, -apple-system, sans-serif;
        padding: 24px;
      }

      .card {
        width: 100%;
        max-width: 420px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 28px;
        text-align: center;
      }

      .status {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        margin-bottom: 14px;
      }

      .status[data-status='connected'] {
        background: var(--green-light);
        border: 1px solid var(--green-border);
        color: var(--green);
      }

      .status[data-status='failed'] {
        background: var(--red-light);
        border: 1px solid var(--red-border);
        color: var(--red);
      }

      h1 {
        font-size: 22px;
        line-height: 1.2;
        margin-bottom: 10px;
      }

      p {
        color: var(--text-secondary);
        font-size: 14px;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="status" data-status="${escapeHtml(input.status)}">${escapeHtml(input.status)}</div>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.message)}</p>
    </main>
    <script>
      (() => {
        const payload = ${serializeJsonLiteralForScript(encodeSourceOAuthPopupResultJson(input.payload))};
        const storageKey = ${serializeValueForScript(`${OAUTH_RESULT_STORAGE_KEY_PREFIX}${input.sessionId}`)};
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(payload));
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

export const ExecutorOAuthLive = HttpApiBuilder.group(
  ExecutorApi,
  "oauth",
  (handlers) =>
    handlers
      .handle("startSourceAuth", ({ path, payload }) =>
        resolveRequestedLocalWorkspace("oauth.start_source_auth", path.workspaceId).pipe(
          Effect.flatMap((executor) =>
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              return yield* executor.oauth.startSourceAuth({
                  baseUrl: resolveRequestOrigin(request),
                  displayName: payload.name,
                  provider: {
                    providerKey: payload.providerKey,
                    config: payload.config ?? null,
                  },
                });
            }).pipe(
              Effect.catchAllCause((cause) =>
                Effect.fail(
                  toStartSourceOAuthError({
                    workspaceId: path.workspaceId,
                    providerKey: payload.providerKey,
                    cause,
                  }),
                ),
              ),
            )
          ),
        ),
      )
      .handle("sourceAuthCallback", ({ urlParams }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          Effect.gen(function* () {
            const completed = yield* Effect.either(
              executor.oauth.completeSourceAuth({
                  state: urlParams.state,
                  code: urlParams.code,
                  error: urlParams.error,
                  errorDescription: urlParams.error_description,
                }),
            );

            if (Either.isRight(completed)) {
              return htmlResponse(
                sourceOAuthPopupResultDocument({
                  title: "OAuth connected",
                  message: "OAuth credentials are ready. Return to the source form to finish saving.",
                  status: "connected",
                  sessionId: completed.right.sessionId,
                  payload: {
                    type: "executor:oauth-result",
                    ok: true,
                    sessionId: completed.right.sessionId,
                    auth: completed.right.auth,
                  },
                }),
              );
            }

            const message = completed.left instanceof Error
              ? completed.left.message
              : "Failed completing OAuth";

            return htmlResponse(
              sourceOAuthPopupResultDocument({
                title: "OAuth failed",
                message,
                status: "failed",
                sessionId: "failed",
                payload: {
                  type: "executor:oauth-result",
                  ok: false,
                  sessionId: null,
                  error: message,
                },
              }),
              500,
            );
          }),
        ),
      ),
);

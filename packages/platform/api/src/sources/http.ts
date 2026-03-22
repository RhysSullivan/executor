import {
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import type {
  ExecutionInteraction,
  Source,
  WorkspaceId,
  WorkspaceOauthClient,
} from "@executor/platform-sdk/schema";
import type {
  ExecutorMcpSourceInput,
  ExecutorSourceInput,
} from "@executor/platform-sdk";
import * as Effect from "effect/Effect";

import {
  sourceAdapterRequiresInteractiveConnect,
} from "@executor/platform-sdk/runtime";
import { WorkspaceOauthClientIdSchema } from "@executor/platform-sdk/schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
} from "../errors";
import { ExecutorApi } from "../api";
import type { ConnectSourcePayload } from "./api";
import {
  getControlPlaneExecutor,
  resolveRequestedLocalWorkspace,
} from "../local-context";

const readHeader = (headers: unknown, name: string): string | null => {
  if (headers == null || typeof headers !== "object") {
    return null;
  }

  const record = headers as Record<string, unknown>;
  const exact = record[name];
  if (typeof exact === "string" && exact.length > 0) {
    return exact;
  }

  const lower = record[name.toLowerCase()];
  if (typeof lower === "string" && lower.length > 0) {
    return lower;
  }

  return null;
};

const resolveRequestOrigin = (request: {
  url: string;
  headers: unknown;
}): string | null => {
  try {
    return new URL(request.url).origin;
  } catch {
    const forwardedHost = readHeader(request.headers, "x-forwarded-host");
    const host = forwardedHost ?? readHeader(request.headers, "host");
    if (!host) {
      return null;
    }

    const forwardedProto = readHeader(request.headers, "x-forwarded-proto");
    const protocol =
      forwardedProto && forwardedProto.length > 0 ? forwardedProto : "http";
    return `${protocol}://${host}`;
  }
};

const toBadRequestError = (operation: string, cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ControlPlaneBadRequestError({
    operation,
    message,
    details: message,
  });
};

const isInteractiveConnectPayload = (
  payload: ConnectSourcePayload,
): payload is Extract<ConnectSourcePayload, { kind?: "mcp" }> =>
  payload.kind === undefined ||
  sourceAdapterRequiresInteractiveConnect(payload.kind);

const nullToUndefined = <T>(value: T | null | undefined): T | undefined =>
  value ?? undefined;

const toWorkspaceOauthClientId = (
  value: string | null | undefined,
): WorkspaceOauthClient["id"] | null | undefined =>
  value == null ? value : WorkspaceOauthClientIdSchema.make(value);

const toExecutorSourceInput = (
  payload: ConnectSourcePayload,
): ExecutorSourceInput | null => {
  if (isInteractiveConnectPayload(payload)) {
    return null;
  }

  switch (payload.kind) {
    case "openapi":
      return {
        kind: "openapi",
        endpoint: payload.endpoint,
        specUrl: payload.specUrl,
        name: payload.name,
        namespace: payload.namespace,
        importAuthPolicy: nullToUndefined(payload.importAuthPolicy),
        importAuth: payload.importAuth,
        auth: payload.auth,
      };
    case "graphql":
      return {
        kind: "graphql",
        endpoint: payload.endpoint,
        name: payload.name,
        namespace: payload.namespace,
        importAuthPolicy: nullToUndefined(payload.importAuthPolicy),
        importAuth: payload.importAuth,
        auth: payload.auth,
      };
    case "google_discovery":
      return {
        kind: "google_discovery",
        service: payload.service,
        version: payload.version,
        discoveryUrl: payload.discoveryUrl,
        scopes: payload.scopes,
        workspaceOauthClientId: toWorkspaceOauthClientId(
          payload.workspaceOauthClientId,
        ),
        oauthClient: payload.oauthClient,
        name: payload.name,
        namespace: payload.namespace,
        importAuthPolicy: nullToUndefined(payload.importAuthPolicy),
        importAuth: payload.importAuth,
        auth: payload.auth,
      };
  }
};

const toExecutorMcpSourceInput = (
  payload: Extract<ConnectSourcePayload, { kind?: "mcp" }>,
  baseUrl: string | null,
): ExecutorMcpSourceInput => ({
  endpoint: payload.endpoint,
  name: payload.name,
  namespace: payload.namespace,
  transport: payload.transport,
  queryParams: payload.queryParams,
  headers: payload.headers,
  command: payload.command,
  args: payload.args,
  env: payload.env,
  cwd: payload.cwd,
  baseUrl,
});

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const serializeJsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");

const SOURCE_OAUTH_RESULT_STORAGE_KEY_PREFIX = "executor:oauth-result:";

const credentialPageDocument = (input: {
  title: string;
  eyebrow: string;
  message: string;
  sourceLabel: string;
  endpoint: string;
  interactionId: string;
  error?: string;
  state?: "pending" | "stored" | "continued" | "cancelled" | "inactive";
}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg: #fafaf9;
        --surface: #ffffff;
        --text: #1c1917;
        --text-secondary: #78716c;
        --text-tertiary: #a8a29e;
        --border: #e7e5e4;
        --accent: #1d4ed8;
        --accent-light: #eff6ff;
        --green: #16a34a;
        --green-light: #f0fdf4;
        --green-border: #bbf7d0;
        --red: #dc2626;
        --red-light: #fef2f2;
        --red-border: #fecaca;
        --amber: #d97706;
        --amber-light: #fffbeb;
        --amber-border: #fde68a;
      }

      * { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
        display: flex;
        justify-content: center;
        padding: 80px 24px 48px;
        -webkit-font-smoothing: antialiased;
      }

      .page {
        width: 100%;
        max-width: 540px;
      }

      /* Status pill at the very top */
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 5px 14px 5px 10px;
        border-radius: 999px;
        font-family: 'DM Mono', monospace;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.01em;
        margin-bottom: 28px;
      }

      .status-pill::before {
        content: '';
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .status-pill[data-state='pending'] {
        background: var(--amber-light);
        color: var(--amber);
        border: 1px solid var(--amber-border);
      }
      .status-pill[data-state='pending']::before { background: var(--amber); }

      .status-pill[data-state='stored'] {
        background: var(--green-light);
        color: var(--green);
        border: 1px solid var(--green-border);
      }
      .status-pill[data-state='stored']::before { background: var(--green); }

      .status-pill[data-state='continued'] {
        background: var(--green-light);
        color: var(--green);
        border: 1px solid var(--green-border);
      }
      .status-pill[data-state='continued']::before { background: var(--green); }

      .status-pill[data-state='cancelled'],
      .status-pill[data-state='inactive'] {
        background: #f5f5f4;
        color: var(--text-secondary);
        border: 1px solid var(--border);
      }
      .status-pill[data-state='cancelled']::before,
      .status-pill[data-state='inactive']::before { background: var(--text-tertiary); }

      /* Title area */
      h1 {
        font-size: 28px;
        font-weight: 600;
        letter-spacing: -0.025em;
        line-height: 1.2;
        margin-bottom: 10px;
      }

      .subtitle {
        font-size: 15px;
        line-height: 1.6;
        color: var(--text-secondary);
      }

      /* Divider */
      hr {
        border: none;
        height: 1px;
        background: var(--border);
        margin: 36px 0;
      }

      /* Source detail rows */
      .detail {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 24px;
      }

      .detail-label {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary);
      }

      .detail-value {
        font-size: 15px;
        line-height: 1.5;
        word-break: break-word;
      }

      .detail-mono {
        font-family: 'DM Mono', monospace;
        font-size: 13px;
        line-height: 1.5;
        padding: 10px 14px;
        background: #f5f5f4;
        border: 1px solid var(--border);
        border-radius: 8px;
        word-break: break-all;
        color: var(--text);
      }

      .detail-id {
        font-family: 'DM Mono', monospace;
        font-size: 12px;
        color: var(--text-tertiary);
      }

      /* Result card for stored/cancelled/inactive */
      .result-card {
        padding: 32px;
        border-radius: 12px;
        text-align: center;
      }

      .result-card.success {
        background: var(--green-light);
        border: 1px solid var(--green-border);
      }

      .result-card.neutral {
        background: #f5f5f4;
        border: 1px solid var(--border);
      }

      .result-card p {
        font-size: 15px;
        line-height: 1.6;
        color: var(--text-secondary);
      }

      .result-card .result-heading {
        font-weight: 600;
        font-size: 15px;
        color: var(--text);
        margin-bottom: 6px;
      }

      /* Form */
      .alert {
        padding: 12px 14px;
        border-radius: 8px;
        background: var(--red-light);
        border: 1px solid var(--red-border);
        color: var(--red);
        font-size: 14px;
        line-height: 1.5;
        margin-bottom: 20px;
      }

      .field { margin-bottom: 20px; }

      label {
        display: block;
        font-size: 14px;
        font-weight: 500;
        margin-bottom: 6px;
      }

      input[type='password'] {
        width: 100%;
        padding: 10px 14px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        font-family: 'DM Mono', monospace;
        font-size: 14px;
        color: var(--text);
        transition: border-color 0.15s, box-shadow 0.15s;
      }

      input[type='password']::placeholder { color: var(--text-tertiary); }

      input[type='password']:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(29, 78, 216, 0.1);
      }

      .hint {
        margin-top: 8px;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-tertiary);
      }

      .actions {
        display: flex;
        gap: 10px;
        margin-top: 24px;
      }

      button {
        appearance: none;
        border: none;
        border-radius: 8px;
        padding: 10px 20px;
        font-family: inherit;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s;
      }

      .primary {
        background: var(--text);
        color: var(--surface);
      }
      .primary:hover { background: #292524; }

      .secondary {
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid var(--border);
      }
      .secondary:hover { background: #f5f5f4; }

      @media (max-width: 540px) {
        body { padding: 48px 20px 32px; }
        h1 { font-size: 24px; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <div class="status-pill" data-state="${escapeHtml(input.state ?? "pending")}">${escapeHtml(input.state ?? "pending")}</div>

      <h1>${escapeHtml(input.title)}</h1>
      <p class="subtitle">${escapeHtml(input.message)}</p>

      <hr />

      <div class="detail">
        <span class="detail-label">Source</span>
        <span class="detail-value">${escapeHtml(input.sourceLabel)}</span>
      </div>

      <div class="detail">
        <span class="detail-label">API endpoint</span>
        <div class="detail-mono">${escapeHtml(input.endpoint)}</div>
      </div>

      <div class="detail">
        <span class="detail-label">Interaction</span>
        <span class="detail-id">${escapeHtml(input.interactionId)}</span>
      </div>

      <hr />

      ${input.error ? `<p class="alert">${escapeHtml(input.error)}</p>` : ""}
      ${
        input.state === "stored"
          ? `<div class="result-card success">
              <p class="result-heading">Credential stored</p>
              <p>Executor resumed the source connection request. You can close this window.</p>
            </div>`
          : input.state === "continued"
            ? `<div class="result-card success">
                <p class="result-heading">Continuing without auth</p>
                <p>Executor resumed the source connection without stored credentials. You can close this window.</p>
              </div>`
            : input.state === "cancelled"
              ? `<div class="result-card neutral">
                <p class="result-heading">Request cancelled</p>
                <p>Executor was notified. You can close this window.</p>
              </div>`
              : input.state === "inactive"
                ? `<div class="result-card neutral">
                  <p class="result-heading">No longer active</p>
                  <p>This credential request has expired. Start a new source connection flow if needed.</p>
                </div>`
                : `<form method="post">
            <div class="field">
              <label for="token">Personal access token</label>
              <input
                id="token"
                name="token"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder="ghp_..."
              />
              <p class="hint">
                Add a token to enable authenticated requests, or continue without auth if this API supports public access.
              </p>
            </div>
            <div class="actions">
              <button class="primary" type="submit" name="action" value="submit">Connect token</button>
              <button class="secondary" type="submit" name="action" value="continue" formnovalidate>Continue without auth</button>
              <button class="secondary" type="submit" name="action" value="cancel" formnovalidate>Cancel</button>
            </div>
          </form>`
      }
    </main>
  </body>
</html>`;

const sourceOAuthPopupResultDocument = (input: {
  title: string;
  message: string;
  state: "stored" | "cancelled";
  sessionId?: string | null;
  payload:
    | {
        type: "executor:source-oauth-result";
        ok: true;
        sourceId: Source["id"];
      }
    | {
        type: "executor:source-oauth-result";
        ok: false;
        error: string;
      };
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

      .status[data-state='stored'] {
        background: var(--green-light);
        border: 1px solid var(--green-border);
        color: var(--green);
      }

      .status[data-state='cancelled'] {
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
      <div class="status" data-state="${escapeHtml(input.state)}">${escapeHtml(input.state === "stored" ? "connected" : "failed")}</div>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.message)}</p>
    </main>
    <script>
      (() => {
        const payload = ${serializeJsonForScript(input.payload)};
        const storageKey = ${serializeJsonForScript(
          input.sessionId
            ? `${SOURCE_OAUTH_RESULT_STORAGE_KEY_PREFIX}${input.sessionId}`
            : null,
        )};
        try {
          if (storageKey) {
            window.localStorage.setItem(storageKey, JSON.stringify(payload));
          }
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

const htmlResponse = (
  html: string,
  status = 200,
): ReturnType<typeof HttpServerResponse.html> =>
  HttpServerResponse.html(html).pipe(
    HttpServerResponse.setStatus(status),
  ) as ReturnType<typeof HttpServerResponse.html>;

const credentialErrorResponse = (input: {
  title: string;
  message: string;
  status: number;
}) =>
  htmlResponse(
    credentialPageDocument({
      title: input.title,
      eyebrow: "Executor",
      message: input.message,
      sourceLabel: "Unavailable",
      endpoint: "Unavailable",
      interactionId: "unavailable",
      state: "inactive",
      error: input.message,
    }),
    input.status,
  );

const credentialErrorStatus = (
  error:
    | ControlPlaneBadRequestError
    | ControlPlaneNotFoundError
    | ControlPlaneStorageError,
) =>
  error instanceof ControlPlaneNotFoundError
    ? 404
    : error instanceof ControlPlaneBadRequestError
      ? 400
      : 500;

const credentialSubmitErrorResponse = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  interactionId: ExecutionInteraction["id"];
  message: string;
  status: number;
}) =>
  resolveRequestedLocalWorkspace(
    "sources.credentialSubmit",
    input.workspaceId,
  ).pipe(
    Effect.flatMap((executor) =>
      executor.effect.local.credentials.get({
          sourceId: input.sourceId,
          interactionId: input.interactionId,
        }),
    ),
    Effect.match({
      onFailure: () =>
        credentialErrorResponse({
          title: "Source Credential Request Failed",
          message: input.message,
          status: input.status,
        }),
      onSuccess: (interaction) =>
        htmlResponse(
          credentialPageDocument({
            title: "Configure Source Access",
            eyebrow: "Executor",
            message: interaction.message,
            sourceLabel: interaction.sourceLabel,
            endpoint: interaction.endpoint,
            interactionId: interaction.interactionId,
            error: input.message,
            state: "pending",
          }),
          input.status,
        ),
    }),
  );

export const ExecutorSourcesLive = HttpApiBuilder.group(
  ExecutorApi,
  "sources",
  (handlers) =>
    handlers
      .handle("discover", ({ payload }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.effect.sources.discover({
              url: payload.url,
              probeAuth: payload.probeAuth,
            }).pipe(
            Effect.catchAll((cause) =>
              Effect.fail(toBadRequestError("sources.discover", cause)),
            ),
          )
        )
      )
      .handle("connect", ({ path, payload }) =>
        resolveRequestedLocalWorkspace(
          "sources.connect",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const baseUrl = resolveRequestOrigin(request);

              if (isInteractiveConnectPayload(payload)) {
                return yield* executor.effect.sources.connect(
                  toExecutorMcpSourceInput(payload, baseUrl),
                );
              }

              const sourceInput = toExecutorSourceInput(payload);
              if (sourceInput) {
                return yield* executor.effect.sources.add(sourceInput, {
                    baseUrl,
                  });
              }

              return yield* Effect.fail(
                toBadRequestError(
                  "sources.connect",
                  new Error("Unsupported source connect payload"),
                ),
              );
            }).pipe(
              Effect.catchAll((cause) =>
                Effect.fail(toBadRequestError("sources.connect", cause)),
              ),
            ),
          ),
        ),
      )
      .handle("connectBatch", ({ path, payload }) =>
        resolveRequestedLocalWorkspace(
          "sources.connectBatch",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              return yield* executor.effect.sources.connectBatch({
                ...payload,
                baseUrl: resolveRequestOrigin(request),
              });
            }).pipe(
              Effect.catchAll((cause) =>
                Effect.fail(toBadRequestError("sources.connectBatch", cause)),
              ),
            ),
          ),
        ),
      )
      .handle("listWorkspaceOauthClients", ({ path, urlParams }) =>
        resolveRequestedLocalWorkspace(
          "sources.listWorkspaceOauthClients",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.sources.oauthClients.list(urlParams.providerKey).pipe(
              Effect.catchAll((cause) =>
                Effect.fail(
                  toBadRequestError("sources.listWorkspaceOauthClients", cause),
                ),
              ),
            )
          ),
        ),
      )
      .handle("createWorkspaceOauthClient", ({ path, payload }) =>
        resolveRequestedLocalWorkspace(
          "sources.createWorkspaceOauthClient",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.sources.oauthClients.create(payload).pipe(
              Effect.catchAll((cause) =>
                Effect.fail(
                  toBadRequestError(
                    "sources.createWorkspaceOauthClient",
                    cause,
                  ),
                ),
              ),
            )
          ),
        ),
      )
      .handle("removeWorkspaceOauthClient", ({ path }) =>
        resolveRequestedLocalWorkspace(
          "sources.removeWorkspaceOauthClient",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.sources.oauthClients.remove(path.oauthClientId).pipe(
              Effect.map((result) => ({ removed: result })),
              Effect.catchAll((cause) =>
                Effect.fail(
                  toBadRequestError(
                    "sources.removeWorkspaceOauthClient",
                    cause,
                  ),
                ),
              ),
            )
          ),
        ),
      )
      .handle("removeProviderAuthGrant", ({ path }) =>
        resolveRequestedLocalWorkspace(
          "sources.removeProviderAuthGrant",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.sources.providerGrants.remove(path.grantId).pipe(
              Effect.map((result) => ({ removed: result })),
              Effect.catchAll((cause) =>
                Effect.fail(
                  toBadRequestError(
                    "sources.removeProviderAuthGrant",
                    cause,
                  ),
                ),
              ),
            )
          ),
        ),
      )
      .handle("list", ({ path }) =>
        resolveRequestedLocalWorkspace("sources.list", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.effect.sources.list()),
        ),
      )
      .handle("create", ({ path, payload }) =>
        resolveRequestedLocalWorkspace("sources.create", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.effect.sources.create(payload)),
        ),
      )
      .handle("get", ({ path }) =>
        resolveRequestedLocalWorkspace("sources.get", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.effect.sources.get(path.sourceId)),
        ),
      )
      .handle("inspection", ({ path }) =>
        resolveRequestedLocalWorkspace(
          "sources.inspection",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.sources.inspection.get(path.sourceId),
          ),
        ),
      )
      .handle("inspectionTool", ({ path }) =>
        resolveRequestedLocalWorkspace(
          "sources.inspection_tool",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.sources.inspection.tool({
                sourceId: path.sourceId,
                toolPath: path.toolPath,
              }),
          ),
        ),
      )
      .handle("inspectionDiscover", ({ path, payload }) =>
        resolveRequestedLocalWorkspace(
          "sources.inspection_discover",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.sources.inspection.discover({
                sourceId: path.sourceId,
                payload,
              }),
          ),
        ),
      )
      .handle("update", ({ path, payload }) =>
        resolveRequestedLocalWorkspace("sources.update", path.workspaceId).pipe(
          Effect.flatMap((executor) =>
            executor.effect.sources.update(path.sourceId, payload)
          ),
        ),
      )
      .handle("remove", ({ path }) =>
        resolveRequestedLocalWorkspace("sources.remove", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.effect.sources.remove(path.sourceId)),
          Effect.map((result) => ({ removed: result.removed })),
        ),
      )
      .handle("credentialPage", ({ path, urlParams }) =>
        resolveRequestedLocalWorkspace(
          "sources.credentialPage",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.local.credentials.get({
                sourceId: path.sourceId,
                interactionId: urlParams.interactionId,
              }),
          ),
          Effect.map((interaction) =>
            htmlResponse(
              credentialPageDocument({
                title: "Configure Source Access",
                eyebrow: "Executor",
                message: interaction.message,
                sourceLabel: interaction.sourceLabel,
                endpoint: interaction.endpoint,
                interactionId: interaction.interactionId,
                state:
                  interaction.status === "pending" ? "pending" : "inactive",
              }),
            ),
          ),
          Effect.catchAll((error) =>
            Effect.succeed(
              credentialErrorResponse({
                title:
                  error instanceof ControlPlaneNotFoundError
                    ? "Source Credential Request Unavailable"
                    : "Source Credential Request Failed",
                message:
                  error instanceof Error ? error.message : "Source credential request failed",
                status:
                  error instanceof ControlPlaneNotFoundError
                    || error instanceof ControlPlaneStorageError
                    || error instanceof ControlPlaneBadRequestError
                    ? credentialErrorStatus(error)
                    : 500,
              }),
            ),
          ),
        ),
      )
      .handle("credentialSubmit", ({ path, urlParams, payload }) =>
        resolveRequestedLocalWorkspace(
          "sources.credentialSubmit",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.local.credentials.submit({
                sourceId: path.sourceId,
                interactionId: urlParams.interactionId,
                action:
                  payload.action === "cancel"
                    ? "cancel"
                    : payload.action === "continue"
                      ? "continue"
                      : "submit",
                token: payload.token,
              }),
          ),
          Effect.map((result) =>
            htmlResponse(
              credentialPageDocument({
                title:
                  result.kind === "stored"
                    ? "Source Credential Stored"
                    : result.kind === "continued"
                      ? "Source Access Updated"
                      : "Source Credential Request Cancelled",
                eyebrow: "Executor",
                message:
                  result.kind === "stored"
                    ? "Executor stored the credential and resumed the source connection."
                    : result.kind === "continued"
                      ? "Executor resumed the source connection without stored credentials."
                      : "Executor cancelled the source credential request.",
                sourceLabel: result.sourceLabel,
                endpoint: result.endpoint,
                interactionId: urlParams.interactionId,
                state:
                  result.kind === "stored"
                    ? "stored"
                    : result.kind === "continued"
                      ? "continued"
                      : "cancelled",
              }),
            ),
          ),
          Effect.catchAll((error) => {
            if (error instanceof ControlPlaneBadRequestError) {
              return credentialSubmitErrorResponse({
                workspaceId: path.workspaceId,
                sourceId: path.sourceId,
                interactionId: urlParams.interactionId,
                message: error.message,
                status: credentialErrorStatus(error),
              });
            }

            return Effect.succeed(
              credentialErrorResponse({
                title:
                  error instanceof ControlPlaneNotFoundError
                    ? "Source Credential Request Unavailable"
                    : "Source Credential Request Failed",
                message:
                  error instanceof Error ? error.message : "Source credential request failed",
                status:
                  error instanceof ControlPlaneNotFoundError
                    || error instanceof ControlPlaneStorageError
                    ? credentialErrorStatus(error)
                    : 500,
              }),
            );
          }),
        ),
      )
      .handle("credentialComplete", ({ path, urlParams }) =>
        resolveRequestedLocalWorkspace(
          "sources.credentialComplete",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.effect.local.credentials.complete({
                sourceId: path.sourceId,
                state: urlParams.state,
                code: urlParams.code,
                error: urlParams.error,
                errorDescription: urlParams.error_description,
              }),
          ),
          Effect.map((completed) =>
            htmlResponse(
              sourceOAuthPopupResultDocument({
                title: "Source connected",
                message: `Source connected: ${completed.source.id}. You can close this window.`,
                state: "stored",
                sessionId: completed.sessionId,
                payload: {
                  type: "executor:source-oauth-result",
                  ok: true,
                  sourceId: completed.source.id,
                },
              }),
            ),
          ),
          Effect.catchAll((error) =>
            Effect.succeed(
              htmlResponse(
                sourceOAuthPopupResultDocument({
                  title: "OAuth failed",
                  message:
                    error instanceof Error
                      ? error.message
                      : "Failed completing OAuth",
                  state: "cancelled",
                  payload: {
                    type: "executor:source-oauth-result",
                    ok: false,
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed completing OAuth",
                  },
                }),
                500,
              ),
            ),
          ),
        ),
      )
      .handle("providerOauthComplete", ({ path, urlParams }) =>
        resolveRequestedLocalWorkspace(
          "sources.providerOauthComplete",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            Effect.gen(function* () {
              const completed = yield* executor.effect.oauth.completeProviderCallback({
                  workspaceId: path.workspaceId,
                  state: urlParams.state,
                  code: urlParams.code,
                  error: urlParams.error,
                  errorDescription: urlParams.error_description,
                });
              const primarySource = completed.sources[0] ?? null;

              return htmlResponse(
                sourceOAuthPopupResultDocument({
                  title: "Sources connected",
                  message: `Connected ${completed.sources.length} source${completed.sources.length === 1 ? "" : "s"}. You can close this window.`,
                  state: "stored",
                  sessionId: completed.sessionId,
                  payload: {
                    type: "executor:source-oauth-result",
                    ok: true,
                    sourceId:
                      primarySource?.id ??
                      ("src_oauth_complete" as Source["id"]),
                  },
                }),
              );
            }).pipe(
              Effect.catchAll((error) =>
                Effect.succeed(
                  htmlResponse(
                    sourceOAuthPopupResultDocument({
                      title: "OAuth failed",
                      message:
                        error instanceof Error
                          ? error.message
                          : "Failed completing OAuth",
                      state: "cancelled",
                      payload: {
                        type: "executor:source-oauth-result",
                        ok: false,
                        error:
                          error instanceof Error
                            ? error.message
                            : "Failed completing OAuth",
                      },
                    }),
                    500,
                  ),
                ),
              ),
            ),
          ),
          Effect.catchAll((error) =>
            Effect.succeed(
              htmlResponse(
                sourceOAuthPopupResultDocument({
                  title: "OAuth failed",
                  message:
                    error instanceof Error
                      ? error.message
                      : "Failed completing OAuth",
                  state: "cancelled",
                  payload: {
                    type: "executor:source-oauth-result",
                    ok: false,
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed completing OAuth",
                  },
                }),
                500,
              ),
            ),
          ),
        ),
      ),
);

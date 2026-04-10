import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Context, Effect } from "effect";

import { addGroup } from "@executor/api";
import type { McpPluginExtension, McpSourceConfig, McpUpdateSourceInput } from "../sdk/plugin";
import { McpGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class McpExtensionService extends Context.Tag(
  "McpExtensionService",
)<McpExtensionService, McpPluginExtension>() {}

// ---------------------------------------------------------------------------
// Composed API
// ---------------------------------------------------------------------------

const ExecutorApiWithMcp = addGroup(McpGroup);

// ---------------------------------------------------------------------------
// OAuth callback HTML
// ---------------------------------------------------------------------------

type OAuthPopupResult =
  | {
      type: "executor:oauth-result";
      ok: true;
      sessionId: string;
      accessTokenSecretId: string;
      refreshTokenSecretId: string | null;
      tokenType: string;
      expiresAt: number | null;
      scope: string | null;
    }
  | {
      type: "executor:oauth-result";
      ok: false;
      sessionId: null;
      error: string;
    };

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const popupDocument = (payload: OAuthPopupResult): string => {
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
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#111">
<style>@media(prefers-color-scheme:dark){body{background:#09090b!important;color:#fafafa!important}p{color:#a1a1aa!important}}</style>
<main style="text-align:center;max-width:360px;padding:24px">
<div style="width:40px;height:40px;border-radius:50%;background:${statusColor};margin:0 auto 16px;display:flex;align-items:center;justify-content:center">
<svg width="20" height="20" viewBox="0 0 20 20" fill="none">${payload.ok ? '<path d="M6 10l3 3 5-6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : '<path d="M7 7l6 6M13 7l-6 6" stroke="white" stroke-width="2" stroke-linecap="round"/>'}</svg>
</div>
<h1 style="margin:0 0 8px;font-size:18px;font-weight:600">${escapeHtml(title)}</h1>
<p style="margin:0;font-size:14px;color:#666;line-height:1.5">${escapeHtml(message)}</p>
</main>
<script>
(()=>{const p=${serialized};try{if(window.opener)window.opener.postMessage(p,window.location.origin);if("BroadcastChannel"in window){const c=new BroadcastChannel("executor:mcp-oauth-result");c.postMessage(p);setTimeout(()=>c.close(),100)}}finally{setTimeout(()=>window.close(),150)}})();
</script>
</body></html>`;
};

// ---------------------------------------------------------------------------
// Convert API payload → McpSourceConfig
// ---------------------------------------------------------------------------

const toSourceConfig = (
  payload: { transport: "remote" | "stdio" } & Record<string, unknown>,
): McpSourceConfig => {
  if (payload.transport === "stdio") {
    const p = payload as {
      transport: "stdio";
      name: string;
      command: string;
      args?: readonly string[];
      env?: Record<string, string>;
      cwd?: string;
      namespace?: string;
    };
    return {
      transport: "stdio",
      name: p.name,
      command: p.command,
      args: p.args ? [...p.args] : undefined,
      env: p.env,
      cwd: p.cwd,
      namespace: p.namespace,
    };
  }

  const p = payload as {
    transport: "remote";
    name: string;
    endpoint: string;
    remoteTransport?: "streamable-http" | "sse" | "auto";
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
    namespace?: string;
    auth?: { kind: string } & Record<string, unknown>;
  };

  // Normalize oauth2 tokenType default
  const auth = p.auth
    ? p.auth.kind === "oauth2"
      ? {
          ...p.auth,
          tokenType:
            (p.auth as { tokenType?: string }).tokenType ?? "Bearer",
        }
      : p.auth
    : undefined;

  return {
    transport: "remote",
    name: p.name,
    endpoint: p.endpoint,
    remoteTransport: p.remoteTransport,
    queryParams: p.queryParams,
    headers: p.headers,
    namespace: p.namespace,
    auth: auth as McpSourceConfig extends { auth?: infer A } ? A : never,
  };
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const McpHandlers = HttpApiBuilder.group(
  ExecutorApiWithMcp,
  "mcp",
  (handlers) =>
    handlers
      .handle("probeEndpoint", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          return yield* ext.probeEndpoint(payload.endpoint);
        }).pipe(Effect.orDie),
      )
      .handle("addSource", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          return yield* ext.addSource(
            toSourceConfig(payload as Parameters<typeof toSourceConfig>[0]),
          );
        }).pipe(Effect.orDie),
      )
      .handle("removeSource", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          yield* ext.removeSource(payload.namespace);
          return { removed: true };
        }).pipe(Effect.orDie),
      )
      .handle("refreshSource", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          return yield* ext.refreshSource(payload.namespace);
        }).pipe(Effect.orDie),
      )
      .handle("startOAuth", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          return yield* ext.startOAuth({
            endpoint: payload.endpoint,
            redirectUrl: payload.redirectUrl,
            queryParams: payload.queryParams,
          });
        }).pipe(Effect.orDie),
      )
      .handle("completeOAuth", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          return yield* ext.completeOAuth({
            state: payload.state,
            code: payload.code,
            error: payload.error,
          });
        }).pipe(Effect.orDie),
      )
      .handle("getSource", ({ path }) =>
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          return yield* ext.getSource(path.namespace);
        }).pipe(Effect.orDie),
      )
      .handle("updateSource", ({ path, payload }) =>
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          yield* ext.updateSource(path.namespace, {
            endpoint: payload.endpoint,
            headers: payload.headers,
            queryParams: payload.queryParams,
            auth: payload.auth as McpUpdateSourceInput["auth"],
          });
          return { updated: true };
        }).pipe(Effect.orDie),
      )
      .handle("oauthCallback", ({ urlParams }) =>
        Effect.gen(function* () {
          const ext = yield* McpExtensionService;
          const result = yield* ext
            .completeOAuth({
              state: urlParams.state,
              code: urlParams.code,
              error:
                urlParams.error ?? urlParams.error_description,
            })
            .pipe(
              Effect.map(
                (c): OAuthPopupResult => ({
                  type: "executor:oauth-result",
                  ok: true,
                  sessionId: urlParams.state,
                  accessTokenSecretId: c.accessTokenSecretId,
                  refreshTokenSecretId: c.refreshTokenSecretId,
                  tokenType: c.tokenType,
                  expiresAt: c.expiresAt,
                  scope: c.scope,
                }),
              ),
              Effect.catchAll((error) =>
                Effect.succeed<OAuthPopupResult>({
                  type: "executor:oauth-result",
                  ok: false,
                  sessionId: null,
                  error:
                    error instanceof Error
                      ? error.message
                      : String(error),
                }),
              ),
            );
          return yield* HttpServerResponse.html(
            popupDocument(result),
          );
        }).pipe(Effect.orDie),
      ),
);

import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Context, Effect } from "effect";

import { addGroup } from "@executor/api";
import type {
  GoogleDiscoveryAddSourceInput,
  GoogleDiscoveryOAuthAuthResult,
  GoogleDiscoveryPluginExtension,
} from "../sdk/plugin";
import { GoogleDiscoveryGroup } from "./group";

export class GoogleDiscoveryExtensionService extends Context.Tag(
  "GoogleDiscoveryExtensionService",
)<GoogleDiscoveryExtensionService, GoogleDiscoveryPluginExtension>() {}

const ExecutorApiWithGoogleDiscovery = addGroup(GoogleDiscoveryGroup);

type OAuthPopupResult =
  | ({
      type: "executor:oauth-result";
      ok: true;
      sessionId: string;
    } & GoogleDiscoveryOAuthAuthResult)
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
(()=>{const p=${serialized};try{if(window.opener)window.opener.postMessage(p,window.location.origin);if("BroadcastChannel"in window){const c=new BroadcastChannel("executor:google-discovery-oauth-result");c.postMessage(p);setTimeout(()=>c.close(),100)}}finally{setTimeout(()=>window.close(),150)}})();
</script>
</body></html>`;
};

export const GoogleDiscoveryHandlers = HttpApiBuilder.group(
  ExecutorApiWithGoogleDiscovery,
  "googleDiscovery",
  (handlers) =>
    handlers
      .handle("probeDiscovery", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.probeDiscovery(payload.discoveryUrl);
        }).pipe(Effect.orDie),
      )
      .handle("addSource", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.addSource(payload as GoogleDiscoveryAddSourceInput);
        }).pipe(Effect.orDie),
      )
      .handle("startOAuth", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.startOAuth({
            name: payload.name,
            discoveryUrl: payload.discoveryUrl,
            clientId: payload.clientId,
            clientSecretSecretId: payload.clientSecretSecretId,
            redirectUrl: payload.redirectUrl,
            scopes: payload.scopes,
          });
        }).pipe(Effect.orDie),
      )
      .handle("completeOAuth", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          return yield* ext.completeOAuth({
            state: payload.state,
            code: payload.code,
            error: payload.error,
          });
        }).pipe(Effect.orDie),
      )
      .handle("oauthCallback", ({ urlParams }) =>
        Effect.gen(function* () {
          const ext = yield* GoogleDiscoveryExtensionService;
          const result = yield* ext
            .completeOAuth({
              state: urlParams.state,
              code: urlParams.code,
              error: urlParams.error ?? urlParams.error_description,
            })
            .pipe(
              Effect.map(
                (auth): OAuthPopupResult => ({
                  type: "executor:oauth-result",
                  ok: true,
                  sessionId: urlParams.state,
                  ...auth,
                }),
              ),
              Effect.catchAll((error) =>
                Effect.succeed<OAuthPopupResult>({
                  type: "executor:oauth-result",
                  ok: false,
                  sessionId: null,
                  error:
                    error instanceof Error ? error.message : String(error),
                }),
              ),
            );
          return yield* HttpServerResponse.html(popupDocument(result));
        }).pipe(Effect.orDie),
      ),
);

import { Effect, Layer } from "effect";

import { authenticated, McpAuthProvider, unauthorized } from "@executor-js/host-mcp";

import { makeAccessVerifier } from "../auth/cloudflare-access";
import type { CloudflareConfig } from "../config";

// ---------------------------------------------------------------------------
// Cloudflare Access McpAuthProvider — the `/mcp` gate, identical identity to the
// API gate. Cloudflare Access sits in front of the Worker and forwards the
// signed `Cf-Access-Jwt-Assertion` on every request, including `/mcp`. So the
// MCP auth seam reuses the SAME `makeAccessVerifier` the IdentityProvider uses:
// validate the JWT, map claims onto the neutral `Principal`, done.
//
// There is no MCP OAuth here. Auth is Access's browser/service-token flow, not
// the MCP `/authorize`+`/token` dance — so `discoveryRoutes` is empty and the
// 401 challenge points at a nominal protected-resource URL only to satisfy
// clients that probe for it. An external MCP client authenticates by presenting
// an Access JWT (or `Cf-Access-Client-Id`/`-Secret` service-token headers, which
// Access converts to one). When MCP OAuth-over-Access is needed, add the
// discovery docs + a token endpoint here behind this same seam.
// ---------------------------------------------------------------------------

export const cloudflareAccessMcpAuth = (config: CloudflareConfig): Layer.Layer<McpAuthProvider> => {
  const { verify } = makeAccessVerifier(config);
  return Layer.succeed(McpAuthProvider)({
    discoveryRoutes: [],
    resourceMetadataUrl: (request) =>
      new URL("/.well-known/oauth-protected-resource", new URL(request.url).origin).toString(),
    authenticate: (request) =>
      verify(request).pipe(
        Effect.map((principal) => (principal ? authenticated(principal) : unauthorized())),
      ),
  });
};

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { computeS256Challenge } from "./anonymous-oauth";

/**
 * Integration tests for the MCP gateway's self-issued anonymous OAuth flow.
 *
 * These tests start a real `Bun.serve` gateway (without Convex — the MCP
 * handler will fail if it tries to talk to Convex, but the OAuth endpoints
 * are entirely self-contained) and drive the full OAuth dance:
 *
 *   1. Discover protected resource metadata
 *   2. Discover authorization server metadata
 *   3. Fetch JWKS
 *   4. Register a client (RFC 7591)
 *   5. Authorize (GET /authorize → redirect with code)
 *   6. Exchange code for token (POST /token)
 *   7. Verify the /mcp endpoint rejects unauthenticated requests
 *   8. Verify the /mcp endpoint accepts the self-issued Bearer token
 */

// We import the gateway init helpers directly to avoid needing CONVEX_URL
import { AnonymousOAuthServer, InMemoryOAuthStorage, OAuthBadRequest } from "./anonymous-oauth";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let oauthServer: AnonymousOAuthServer;

/** Generate a random PKCE code_verifier. */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Start a lightweight server that only exposes the OAuth endpoints
// (no Convex dependency) plus a stub /mcp that checks for a valid token.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // We start our own server so we don't need CONVEX_URL.
  const port = 0; // random available port
  oauthServer = new AnonymousOAuthServer({
    issuer: "http://placeholder",
    storage: new InMemoryOAuthStorage(),
  });
  await oauthServer.init();

  server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);

      // Patch the issuer to use the real server origin (port is dynamic)
      const origin = `http://127.0.0.1:${server.port}`;

      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        });
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        // Return metadata with the real origin
        const meta = oauthServer.getMetadata();
        return Response.json({
          ...meta,
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          jwks_uri: `${origin}/oauth2/jwks`,
        });
      }

      if (url.pathname === "/oauth2/jwks") {
        return Response.json(oauthServer.getJwks(), {
          headers: { "cache-control": "public, max-age=3600" },
        });
      }

      if (url.pathname === "/register" && request.method === "POST") {
        const body = await request.json();
        try {
          const reg = await oauthServer.registerClient(body as any);
          return Response.json(reg, { status: 201 });
        } catch (error) {
          if (error instanceof OAuthBadRequest) {
            return Response.json(
              { error: "invalid_client_metadata", error_description: error.message },
              { status: 400 },
            );
          }
          throw error;
        }
      }

      if (url.pathname === "/authorize" && request.method === "GET") {
        try {
          const { redirectTo } = await oauthServer.authorize(url.searchParams);
          return Response.redirect(redirectTo, 302);
        } catch (error) {
          if (error instanceof OAuthBadRequest) {
            return Response.json(
              { error: "invalid_request", error_description: error.message },
              { status: 400 },
            );
          }
          throw error;
        }
      }

      if (url.pathname === "/token" && request.method === "POST") {
        const text = await request.text();
        const body = new URLSearchParams(text);
        try {
          const tokens = await oauthServer.exchangeToken(body);
          return Response.json(tokens, {
            headers: { "cache-control": "no-store" },
          });
        } catch (error) {
          if (error instanceof OAuthBadRequest) {
            return Response.json(
              { error: "invalid_grant", error_description: error.message },
              { status: 400 },
            );
          }
          throw error;
        }
      }

      // Stub /mcp that validates the Bearer token
      if (url.pathname === "/mcp") {
        const authHeader = request.headers.get("authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return Response.json(
            { error: "Authorization required." },
            {
              status: 401,
              headers: {
                "WWW-Authenticate": [
                  'Bearer error="unauthorized"',
                  'error_description="Authorization needed"',
                  `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
                ].join(", "),
              },
            },
          );
        }

        const token = authHeader.slice("Bearer ".length).trim();
        const verified = await oauthServer.verifyToken(token);
        if (!verified) {
          return Response.json({ error: "Invalid token" }, { status: 401 });
        }

        return Response.json({
          ok: true,
          sub: verified.sub,
          provider: verified.provider,
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  baseUrl = `http://127.0.0.1:${server.port}`;

  // Update the oauth server's issuer to match the real URL
  // We do this by re-initializing with the correct issuer
  oauthServer = new AnonymousOAuthServer({
    issuer: baseUrl,
    storage: new InMemoryOAuthStorage(),
  });
  await oauthServer.init();
});

afterAll(() => {
  server?.stop(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Gateway OAuth Integration", () => {

  // ── Discovery ───────────────────────────────────────────────────────────

  test("GET /.well-known/oauth-protected-resource returns resource metadata", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(`${baseUrl}/mcp`);
    expect(body.authorization_servers).toContain(baseUrl);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  test("GET /.well-known/oauth-authorization-server returns server metadata", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe(baseUrl);
    expect(body.authorization_endpoint).toBe(`${baseUrl}/authorize`);
    expect(body.token_endpoint).toBe(`${baseUrl}/token`);
    expect(body.registration_endpoint).toBe(`${baseUrl}/register`);
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.grant_types_supported).toEqual(["authorization_code"]);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("GET /oauth2/jwks returns a JWKS with an RSA key", async () => {
    const res = await fetch(`${baseUrl}/oauth2/jwks`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age");
    const body = await res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].kty).toBe("RSA");
    expect(body.keys[0].alg).toBe("RS256");
    expect(body.keys[0].kid).toBeDefined();
  });

  // ── Client Registration ─────────────────────────────────────────────────

  test("POST /register creates a client with a client_id", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "test-integration-client",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toStartWith("anon_client_");
    expect(body.client_name).toBe("test-integration-client");
    expect(body.redirect_uris).toEqual(["http://localhost:9999/callback"]);
  });

  test("POST /register rejects missing redirect_uris", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "no-redirects" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_client_metadata");
  });

  // ── Authorization + Token Exchange (full flow) ──────────────────────────

  test("full OAuth flow: register → authorize → token → access /mcp", async () => {
    // Step 1: Register
    const regRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/callback"],
      }),
    });
    const { client_id } = await regRes.json();

    // Step 2: Authorize (with PKCE)
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await computeS256Challenge(codeVerifier);

    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "my-state");

    const authRes = await fetch(authorizeUrl.toString(), { redirect: "manual" });
    expect(authRes.status).toBe(302);

    const location = authRes.headers.get("location")!;
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location);
    expect(redirectUrl.searchParams.get("state")).toBe("my-state");
    const code = redirectUrl.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // Step 3: Exchange code for token
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: "http://localhost:9999/callback",
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");

    const tokenBody = await tokenRes.json();
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBeGreaterThan(0);

    // Step 4: Use the token on /mcp
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = await mcpRes.json();
    expect(mcpBody.ok).toBe(true);
    expect(mcpBody.sub).toStartWith("anon_");
    expect(mcpBody.provider).toBe("anonymous");
  });

  // ── Unauthenticated /mcp → 401 ─────────────────────────────────────────

  test("POST /mcp without token returns 401 with WWW-Authenticate", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get("www-authenticate")!;
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");

    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("POST /mcp with invalid token returns 401", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer invalid.jwt.token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  // ── Token endpoint error cases ──────────────────────────────────────────

  test("POST /token with wrong grant_type returns error", async () => {
    const res = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });

  test("POST /token with invalid code returns error", async () => {
    const res = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "nonexistent-code",
        redirect_uri: "http://localhost:9999/callback",
        code_verifier: "whatever",
      }).toString(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });

  // ── Each flow produces unique actor IDs ─────────────────────────────────

  test("different auth flows produce different anonymous actor IDs", async () => {
    const subs = new Set<string>();

    for (let i = 0; i < 3; i++) {
      const regRes = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:9999/callback"] }),
      });
      const { client_id } = await regRes.json();

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeS256Challenge(codeVerifier);

      const authorizeUrl = new URL(`${baseUrl}/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", client_id);
      authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const authRes = await fetch(authorizeUrl.toString(), { redirect: "manual" });
      const location = authRes.headers.get("location")!;
      const code = new URL(location).searchParams.get("code")!;

      const tokenRes = await fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id,
          redirect_uri: "http://localhost:9999/callback",
          code_verifier: codeVerifier,
        }).toString(),
      });
      const { access_token } = await tokenRes.json();

      const mcpRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const { sub } = await mcpRes.json();
      subs.add(sub);
    }

    expect(subs.size).toBe(3);
  });
});

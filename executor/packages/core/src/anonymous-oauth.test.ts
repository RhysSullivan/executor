import { describe, test, expect, beforeAll } from "bun:test";
import {
  AnonymousOAuthServer,
  InMemoryOAuthStorage,
  OAuthBadRequest,
  computeS256Challenge,
} from "./anonymous-oauth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createServer(issuer = "http://localhost:3003"): AnonymousOAuthServer {
  return new AnonymousOAuthServer({ issuer, storage: new InMemoryOAuthStorage() });
}

/** Generate a random PKCE code_verifier (43–128 chars, unreserved). */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registerAndAuthorize(
  server: AnonymousOAuthServer,
  redirectUri = "http://localhost:9999/callback",
) {
  const client = await server.registerClient({
    redirect_uris: [redirectUri],
    client_name: "test-client",
  });

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeS256Challenge(codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: "test-state-123",
  });

  const { redirectTo } = await server.authorize(params);
  const redirectUrl = new URL(redirectTo);
  const code = redirectUrl.searchParams.get("code")!;

  return { client, codeVerifier, codeChallenge, code, redirectUrl, redirectUri };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnonymousOAuthServer", () => {
  let server: AnonymousOAuthServer;
  let storage: InMemoryOAuthStorage;

  beforeAll(async () => {
    storage = new InMemoryOAuthStorage();
    server = new AnonymousOAuthServer({
      issuer: "http://localhost:3003",
      storage,
    });
    await server.init();
  });

  // ── Metadata ────────────────────────────────────────────────────────────

  describe("getMetadata", () => {
    test("returns RFC 8414 compliant metadata", () => {
      const metadata = server.getMetadata();
      expect(metadata.issuer).toBe("http://localhost:3003");
      expect(metadata.authorization_endpoint).toBe("http://localhost:3003/authorize");
      expect(metadata.token_endpoint).toBe("http://localhost:3003/token");
      expect(metadata.registration_endpoint).toBe("http://localhost:3003/register");
      expect(metadata.jwks_uri).toBe("http://localhost:3003/oauth2/jwks");
      expect(metadata.response_types_supported).toEqual(["code"]);
      expect(metadata.grant_types_supported).toEqual(["authorization_code"]);
      expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    });

    test("strips trailing slashes from issuer", async () => {
      const s = createServer("http://localhost:3003///");
      await s.init();
      expect(s.getMetadata().issuer).toBe("http://localhost:3003");
    });
  });

  // ── JWKS ────────────────────────────────────────────────────────────────

  describe("getJwks", () => {
    test("returns a JWKS with one RSA public key", () => {
      const jwks = server.getJwks();
      expect(jwks.keys).toHaveLength(1);
      const key = jwks.keys[0];
      expect(key.kty).toBe("RSA");
      expect(key.use).toBe("sig");
      expect(key.alg).toBe("RS256");
      expect(key.kid).toBeDefined();
      // Public key should not include private components
      expect(key.d).toBeUndefined();
    });
  });

  // ── Client Registration ─────────────────────────────────────────────────

  describe("registerClient", () => {
    test("registers a client and returns a client_id", async () => {
      const reg = await server.registerClient({
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "my-mcp-client",
      });

      expect(reg.client_id).toStartWith("anon_client_");
      expect(reg.client_name).toBe("my-mcp-client");
      expect(reg.redirect_uris).toEqual(["http://localhost:9999/callback"]);
      expect(reg.created_at).toBeGreaterThan(0);
    });

    test("rejects registration without redirect_uris", async () => {
      await expect(server.registerClient({} as any)).rejects.toThrow(OAuthBadRequest);
    });

    test("rejects registration with empty redirect_uris", async () => {
      await expect(server.registerClient({ redirect_uris: [] })).rejects.toThrow(OAuthBadRequest);
    });

    test("rejects registration with invalid redirect_uri entries", async () => {
      await expect(server.registerClient({ redirect_uris: [""] })).rejects.toThrow(OAuthBadRequest);
    });

    test("rejects registration with non-URL redirect_uri", async () => {
      await expect(
        server.registerClient({ redirect_uris: ["not-a-url"] }),
      ).rejects.toThrow("Invalid redirect_uri");
    });

    test("increments client count in storage", async () => {
      const before = storage.clientCount;
      await server.registerClient({ redirect_uris: ["http://example.com/cb"] });
      expect(storage.clientCount).toBe(before + 1);
    });
  });

  // ── Authorization ───────────────────────────────────────────────────────

  describe("authorize", () => {
    test("returns redirect with code and state", async () => {
      const { redirectUrl } = await registerAndAuthorize(server);
      expect(redirectUrl.searchParams.get("code")).toBeTruthy();
      expect(redirectUrl.searchParams.get("state")).toBe("test-state-123");
      expect(redirectUrl.origin).toBe("http://localhost:9999");
      expect(redirectUrl.pathname).toBe("/callback");
    });

    test("rejects unsupported response_type", async () => {
      const client = await server.registerClient({
        redirect_uris: ["http://localhost/cb"],
      });
      const params = new URLSearchParams({
        response_type: "token",
        client_id: client.client_id,
        redirect_uri: "http://localhost/cb",
        code_challenge: "abc",
        code_challenge_method: "S256",
      });
      await expect(server.authorize(params)).rejects.toThrow("response_type must be 'code'");
    });

    test("rejects unknown client_id", async () => {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: "unknown",
        redirect_uri: "http://localhost/cb",
        code_challenge: "abc",
        code_challenge_method: "S256",
      });
      await expect(server.authorize(params)).rejects.toThrow("Unknown client_id");
    });

    test("rejects mismatched redirect_uri", async () => {
      const client = await server.registerClient({
        redirect_uris: ["http://localhost/cb"],
      });
      const params = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://evil.com/cb",
        code_challenge: "abc",
        code_challenge_method: "S256",
      });
      await expect(server.authorize(params)).rejects.toThrow("redirect_uri does not match");
    });

    test("rejects missing PKCE challenge", async () => {
      const client = await server.registerClient({
        redirect_uris: ["http://localhost/cb"],
      });
      const params = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://localhost/cb",
      });
      await expect(server.authorize(params)).rejects.toThrow("PKCE S256 code_challenge is required");
    });

    test("rejects non-S256 PKCE method", async () => {
      const client = await server.registerClient({
        redirect_uris: ["http://localhost/cb"],
      });
      const params = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://localhost/cb",
        code_challenge: "abc",
        code_challenge_method: "plain",
      });
      await expect(server.authorize(params)).rejects.toThrow("PKCE S256 code_challenge is required");
    });
  });

  // ── Token Exchange ──────────────────────────────────────────────────────

  describe("exchangeToken", () => {
    test("exchanges code for a valid JWT access token", async () => {
      const { client, code, codeVerifier, redirectUri } = await registerAndAuthorize(server);

      const result = await server.exchangeToken(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      );

      expect(result.token_type).toBe("Bearer");
      expect(result.expires_in).toBeGreaterThan(0);
      expect(result.access_token).toBeTruthy();

      // Verify the token is a valid JWT we can decode
      const verified = await server.verifyToken(result.access_token);
      expect(verified).not.toBeNull();
      expect(verified!.sub).toStartWith("anon_");
      expect(verified!.provider).toBe("anonymous");
    });

    test("supports binding a specific anonymous actor subject", async () => {
      const redirectUri = "http://localhost:9999/callback";
      const client = await server.registerClient({
        redirect_uris: [redirectUri],
      });

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeS256Challenge(codeVerifier);
      const actorId = `anon_${crypto.randomUUID()}`;

      const params = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const { redirectTo } = await server.authorize(params, { actorId });
      const code = new URL(redirectTo).searchParams.get("code")!;

      const { access_token } = await server.exchangeToken(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      );

      const verified = await server.verifyToken(access_token);
      expect(verified).not.toBeNull();
      expect(verified!.sub).toBe(actorId);
    });

    test("includes custom claims and filters reserved JWT claims", async () => {
      const redirectUri = "http://localhost:9999/callback";
      const client = await server.registerClient({
        redirect_uris: [redirectUri],
      });

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeS256Challenge(codeVerifier);
      const params = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const { redirectTo } = await server.authorize(params, {
        tokenClaims: {
          workspace_id: "ws_123",
          session_id: "mcp_session_123",
          sub: "ignored",
          iss: "ignored",
        },
      });
      const code = new URL(redirectTo).searchParams.get("code")!;

      const { access_token } = await server.exchangeToken(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      );

      const verified = await server.verifyToken(access_token);
      expect(verified).not.toBeNull();
      expect(verified!.claims.workspace_id).toBe("ws_123");
      expect(verified!.claims.session_id).toBe("mcp_session_123");
      expect(verified!.sub).toStartWith("anon_");
    });

    test("code is single-use", async () => {
      const { client, code, codeVerifier, redirectUri } = await registerAndAuthorize(server);

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });

      // First exchange succeeds
      await server.exchangeToken(body);

      // Second exchange fails
      await expect(server.exchangeToken(body)).rejects.toThrow("invalid or expired code");
    });

    test("rejects wrong grant_type", async () => {
      await expect(
        server.exchangeToken(new URLSearchParams({ grant_type: "client_credentials" })),
      ).rejects.toThrow("grant_type must be authorization_code");
    });

    test("rejects wrong client_id", async () => {
      const { code, codeVerifier, redirectUri } = await registerAndAuthorize(server);

      await expect(
        server.exchangeToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: "anon_client_wrong",
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
        ),
      ).rejects.toThrow("client_id mismatch");
    });

    test("rejects expired code", async () => {
      // Create server with very short code expiry
      const shortServer = new AnonymousOAuthServer({
        issuer: "http://localhost:3003",
        codeExpirySeconds: 0, // expires immediately
        storage: new InMemoryOAuthStorage(),
      });
      await shortServer.init();

      const { client, code, codeVerifier, redirectUri } = await registerAndAuthorize(shortServer);

      // Wait a tick for the code to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(
        shortServer.exchangeToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: client.client_id,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
        ),
      ).rejects.toThrow("authorization code has expired");
    });

    test("rejects wrong redirect_uri", async () => {
      const { client, code, codeVerifier } = await registerAndAuthorize(server);

      await expect(
        server.exchangeToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: client.client_id,
            redirect_uri: "http://evil.com/cb",
            code_verifier: codeVerifier,
          }),
        ),
      ).rejects.toThrow("redirect_uri mismatch");
    });

    test("rejects wrong code_verifier", async () => {
      const { client, code, redirectUri } = await registerAndAuthorize(server);

      await expect(
        server.exchangeToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: client.client_id,
            redirect_uri: redirectUri,
            code_verifier: "wrong-verifier-value",
          }),
        ),
      ).rejects.toThrow("code_verifier does not match code_challenge");
    });

    test("rejects missing code_verifier", async () => {
      const { client, code, redirectUri } = await registerAndAuthorize(server);

      await expect(
        server.exchangeToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: client.client_id,
            redirect_uri: redirectUri,
          }),
        ),
      ).rejects.toThrow("code_verifier is required");
    });
  });

  // ── Token Verification ──────────────────────────────────────────────────

  describe("verifyToken", () => {
    test("verifies a self-issued token", async () => {
      const { client, code, codeVerifier, redirectUri } = await registerAndAuthorize(server);
      const { access_token } = await server.exchangeToken(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      );

      const result = await server.verifyToken(access_token);
      expect(result).not.toBeNull();
      expect(result!.sub).toStartWith("anon_");
      expect(result!.provider).toBe("anonymous");
    });

    test("rejects garbage tokens", async () => {
      const result = await server.verifyToken("not.a.jwt");
      expect(result).toBeNull();
    });

    test("rejects tokens from a different server", async () => {
      const otherServer = createServer("http://other-server:4000");
      await otherServer.init();

      const { client, code, codeVerifier, redirectUri } = await registerAndAuthorize(otherServer);
      const { access_token } = await otherServer.exchangeToken(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      );

      // Our server should reject a token from the other server
      const result = await server.verifyToken(access_token);
      expect(result).toBeNull();
    });
  });

  // ── PKCE S256 ───────────────────────────────────────────────────────────

  describe("computeS256Challenge", () => {
    test("produces a deterministic base64url-encoded SHA-256 hash", async () => {
      const challenge1 = await computeS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
      const challenge2 = await computeS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
      expect(challenge1).toBe(challenge2);
      // Known value from RFC 7636 Appendix B
      expect(challenge1).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });
  });

  // ── Code Purging ────────────────────────────────────────────────────────

  describe("purgeExpiredCodes", () => {
    test("removes expired codes", async () => {
      const s = new AnonymousOAuthServer({
        issuer: "http://localhost:3003",
        codeExpirySeconds: 0,
        storage: new InMemoryOAuthStorage(),
      });
      await s.init();

      // Generate some codes
      await registerAndAuthorize(s);
      await registerAndAuthorize(s);
      expect(await s.getCodeCount()).toBe(2);

      // Wait for them to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      const purged = await s.purgeExpiredCodes();
      expect(purged).toBe(2);
      expect(await s.getCodeCount()).toBe(0);
    });
  });

  // ── Authorization code cap ────────────────────────────────────────────────

  describe("authorization code cap", () => {
    test("rejects new authorizations when at max pending codes", async () => {
      const s = new AnonymousOAuthServer({
        issuer: "http://localhost:3003",
        maxPendingCodes: 2,
        codeExpirySeconds: 300, // long-lived so they don't auto-purge
        storage: new InMemoryOAuthStorage(),
      });
      await s.init();

      // Fill up the code slots
      await registerAndAuthorize(s);
      await registerAndAuthorize(s);
      expect(await s.getCodeCount()).toBe(2);

      // Third should be rejected
      await expect(registerAndAuthorize(s)).rejects.toThrow(
        "Too many pending authorization requests",
      );
    });

    test("auto-purges expired codes before rejecting", async () => {
      const s = new AnonymousOAuthServer({
        issuer: "http://localhost:3003",
        maxPendingCodes: 2,
        codeExpirySeconds: 0, // codes expire immediately
        storage: new InMemoryOAuthStorage(),
      });
      await s.init();

      // Fill slots (they expire immediately)
      await registerAndAuthorize(s);
      await registerAndAuthorize(s);
      expect(await s.getCodeCount()).toBe(2);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should succeed because expired codes are purged
      const { code } = await registerAndAuthorize(s);
      expect(code).toBeTruthy();
    });
  });

  // ── Key persistence via storage ─────────────────────────────────────────

  describe("key persistence", () => {
    test("reuses key from storage on second init", async () => {
      const sharedStorage = new InMemoryOAuthStorage();

      // First server generates a key
      const s1 = new AnonymousOAuthServer({
        issuer: "http://localhost:3003",
        storage: sharedStorage,
      });
      await s1.init();
      const jwks1 = s1.getJwks();

      // Second server should load the same key from storage
      const s2 = new AnonymousOAuthServer({
        issuer: "http://localhost:3003",
        storage: sharedStorage,
      });
      await s2.init();
      const jwks2 = s2.getJwks();

      expect(jwks1.keys[0].kid).toBe(jwks2.keys[0].kid);
      expect(jwks1.keys[0].n).toBe(jwks2.keys[0].n);
    });

    test("token from first server is verified by second server with same storage", async () => {
      const sharedStorage = new InMemoryOAuthStorage();

      const s1 = new AnonymousOAuthServer({
        issuer: "http://localhost:3003",
        storage: sharedStorage,
      });
      await s1.init();

      const { client, code, codeVerifier, redirectUri } = await registerAndAuthorize(s1);
      const { access_token } = await s1.exchangeToken(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      );

      // "Restart" the gateway — new server instance, same storage
      const s2 = new AnonymousOAuthServer({
        issuer: "http://localhost:3003",
        storage: sharedStorage,
      });
      await s2.init();

      // Token from s1 should be valid on s2
      const verified = await s2.verifyToken(access_token);
      expect(verified).not.toBeNull();
      expect(verified!.sub).toStartWith("anon_");
      expect(verified!.provider).toBe("anonymous");
    });
  });

  // ── Each authorize creates a unique actor ───────────────────────────────

  describe("unique anonymous identities", () => {
    test("each authorization produces a different actor sub", async () => {
      const subs = new Set<string>();

      for (let i = 0; i < 5; i++) {
        const { client, code, codeVerifier, redirectUri } = await registerAndAuthorize(server);
        const { access_token } = await server.exchangeToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: client.client_id,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
        );
        const verified = await server.verifyToken(access_token);
        subs.add(verified!.sub);
      }

      expect(subs.size).toBe(5);
    });
  });
});

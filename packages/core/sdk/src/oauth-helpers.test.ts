// ---------------------------------------------------------------------------
// Fidelity suite — locks in every edge case the prior hand-rolled
// google-discovery oauth.ts handled, so future "simplifications" of the
// shared helpers fail loudly instead of silently breaking refresh / parsing /
// provider-specific quirks.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Exit } from "effect";

import {
  OAUTH2_DEFAULT_TIMEOUT_MS,
  OAUTH2_REFRESH_SKEW_MS,
  OAuth2Error,
  buildAuthorizationUrl,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  refreshAccessToken,
  shouldRefreshToken,
} from "./oauth-helpers";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe("PKCE", () => {
  it("createPkceCodeVerifier returns a base64url string in the RFC 7636 length range", () => {
    for (let i = 0; i < 25; i++) {
      const verifier = createPkceCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
    }
  });

  it("createPkceCodeChallenge matches the RFC 7636 Appendix A test vector", async () => {
    // RFC 7636 §4.2 test vector
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await createPkceCodeChallenge(verifier)).toBe(expected);
  });

  it("createPkceCodeVerifier produces unique values", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(createPkceCodeVerifier());
    expect(seen.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// buildAuthorizationUrl
// ---------------------------------------------------------------------------

describe("buildAuthorizationUrl", () => {
  // RFC 7636 §4.2 test-vector pair — verifier+challenge precomputed so
  // the URL builder stays a pure sync function.
  const baseInput = {
    authorizationUrl: "https://example.com/authorize",
    clientId: "client-123",
    redirectUrl: "https://app.example.com/callback",
    scopes: ["read", "write"] as const,
    state: "state-abc",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  };

  it("emits all RFC 6749 + PKCE params", () => {
    const url = new URL(buildAuthorizationUrl(baseInput));
    expect(url.origin + url.pathname).toBe("https://example.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("supports a custom scope separator (e.g. comma for legacy providers)", () => {
    const url = new URL(buildAuthorizationUrl({ ...baseInput, scopeSeparator: "," }));
    expect(url.searchParams.get("scope")).toBe("read,write");
  });

  it("merges Google-style extra params without dropping them", () => {
    const url = new URL(
      buildAuthorizationUrl({
        ...baseInput,
        extraParams: {
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
        },
      }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    // Standard params are still present.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("preserves pre-existing query params on the authorization URL", () => {
    const url = new URL(
      buildAuthorizationUrl({ ...baseInput, authorizationUrl: "https://example.com/auth?tenant=acme" }),
    );
    expect(url.searchParams.get("tenant")).toBe("acme");
    expect(url.searchParams.get("client_id")).toBe("client-123");
  });
});

// ---------------------------------------------------------------------------
// exchangeAuthorizationCode / refreshAccessToken — request shape
// ---------------------------------------------------------------------------

type FetchArgs = { url: string; init: RequestInit };

const captureFetch = (response: Response): { calls: FetchArgs[] } => {
  const calls: FetchArgs[] = [];
  globalThis.fetch = vi
    .fn()
    .mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response;
    }) as unknown as typeof fetch;
  return { calls };
};

const originalFetch = globalThis.fetch;

const jwtPart = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const unsignedJwt = (claims: Record<string, unknown>): string =>
  `${jwtPart({ alg: "RS256", typ: "JWT" })}.${jwtPart(claims)}.sig`;

describe("exchangeAuthorizationCode", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const validBody = {
    access_token: "tok",
    token_type: "Bearer",
    refresh_token: "rtok",
    expires_in: 3600,
    scope: "read",
  };

  it("posts form-urlencoded body with grant_type=authorization_code and PKCE verifier", async () => {
    const { calls } = captureFetch(jsonResponse(200, validBody));
    const result = await Effect.runPromise(
      exchangeAuthorizationCode({
        tokenUrl: "https://example.com/token",
        clientId: "cid",
        clientSecret: "csecret",
        redirectUrl: "https://app.example.com/cb",
        codeVerifier: "verifier",
        code: "abc",
      }),
    );
    expect(result.access_token).toBe("tok");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://example.com/token");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-type"]).toMatch(/^application\/x-www-form-urlencoded/);
    expect(headers["accept"]).toContain("application/json");
    const body = call.init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csecret");
    expect(body.get("redirect_uri")).toBe("https://app.example.com/cb");
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("code")).toBe("abc");
  });

  it("omits client_secret when none is provided (public clients with PKCE)", async () => {
    const { calls } = captureFetch(jsonResponse(200, validBody));
    await Effect.runPromise(
      exchangeAuthorizationCode({
        tokenUrl: "https://example.com/token",
        clientId: "cid",
        redirectUrl: "https://app.example.com/cb",
        codeVerifier: "verifier",
        code: "abc",
      }),
    );
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("client_id")).toBe("cid");
    expect(body.has("client_secret")).toBe(false);
  });

  it("validates ID tokens against an explicit issuer when token host differs", async () => {
    captureFetch(
      jsonResponse(200, {
        ...validBody,
        id_token: unsignedJwt({
          iss: "https://accounts.google.com",
          aud: "cid",
          sub: "user-1",
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }),
      }),
    );
    const result = await Effect.runPromise(
      exchangeAuthorizationCode({
        tokenUrl: "https://oauth2.googleapis.com/token",
        issuerUrl: "https://accounts.google.com",
        clientId: "cid",
        redirectUrl: "https://app.example.com/cb",
        codeVerifier: "verifier",
        code: "abc",
      }),
    );
    expect(result.access_token).toBe("tok");
  });

  it("uses HTTP Basic auth when clientAuth=basic (Stripe-style)", async () => {
    const { calls } = captureFetch(jsonResponse(200, validBody));
    await Effect.runPromise(
      exchangeAuthorizationCode({
        tokenUrl: "https://example.com/token",
        clientId: "cid",
        clientSecret: "csecret",
        redirectUrl: "https://app.example.com/cb",
        codeVerifier: "verifier",
        code: "abc",
        clientAuth: "basic",
      }),
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from("cid:csecret").toString("base64")}`;
    expect(headers["authorization"]).toBe(expected);
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.has("client_id")).toBe(false);
    expect(body.has("client_secret")).toBe(false);
  });

  it("sets a 20-second AbortSignal timeout by default", async () => {
    const { calls } = captureFetch(jsonResponse(200, validBody));
    await Effect.runPromise(
      exchangeAuthorizationCode({
        tokenUrl: "https://example.com/token",
        clientId: "cid",
        redirectUrl: "https://cb",
        codeVerifier: "v",
        code: "c",
      }),
    );
    expect(OAUTH2_DEFAULT_TIMEOUT_MS).toBe(20_000);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a typed OAuth2Error on transport failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    const exit = await Effect.runPromiseExit(
      exchangeAuthorizationCode({
        tokenUrl: "https://example.com/token",
        clientId: "cid",
        redirectUrl: "https://cb",
        codeVerifier: "v",
        code: "c",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause;
      const failure = JSON.stringify(err);
      expect(failure).toContain("OAuth2Error");
      expect(failure).toContain("boom");
    }
  });

  it("propagates RFC 6749 error_description text in the OAuth2Error", async () => {
    captureFetch(
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Code expired",
      }),
    );
    const exit = await Effect.runPromiseExit(
      exchangeAuthorizationCode({
        tokenUrl: "https://example.com/token",
        clientId: "cid",
        redirectUrl: "https://cb",
        codeVerifier: "v",
        code: "c",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("Code expired");
    }
  });
});

describe("refreshAccessToken", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const validBody = { access_token: "tok2", token_type: "Bearer", expires_in: 3600 };

  it("posts grant_type=refresh_token with the refresh token", async () => {
    const { calls } = captureFetch(jsonResponse(200, validBody));
    await Effect.runPromise(
      refreshAccessToken({
        tokenUrl: "https://example.com/token",
        clientId: "cid",
        clientSecret: "csecret",
        refreshToken: "old",
      }),
    );
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csecret");
  });

  it("includes scope when scopes are provided", async () => {
    const { calls } = captureFetch(jsonResponse(200, validBody));
    await Effect.runPromise(
      refreshAccessToken({
        tokenUrl: "https://example.com/token",
        clientId: "cid",
        refreshToken: "old",
        scopes: ["a", "b"],
      }),
    );
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("scope")).toBe("a b");
  });

  it("omits scope when scopes is empty", async () => {
    const { calls } = captureFetch(jsonResponse(200, validBody));
    await Effect.runPromise(
      refreshAccessToken({
        tokenUrl: "https://example.com/token",
        clientId: "cid",
        refreshToken: "old",
        scopes: [],
      }),
    );
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.has("scope")).toBe(false);
  });

  it("validates refreshed ID tokens against an explicit issuer", async () => {
    captureFetch(
      jsonResponse(200, {
        ...validBody,
        id_token: unsignedJwt({
          iss: "https://accounts.google.com",
          aud: "cid",
          sub: "user-1",
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }),
      }),
    );
    const result = await Effect.runPromise(
      refreshAccessToken({
        tokenUrl: "https://oauth2.googleapis.com/token",
        issuerUrl: "https://accounts.google.com",
        clientId: "cid",
        refreshToken: "old",
      }),
    );
    expect(result.access_token).toBe("tok2");
  });
});

// ---------------------------------------------------------------------------
// shouldRefreshToken
// ---------------------------------------------------------------------------

describe("shouldRefreshToken", () => {
  it("never refreshes when expiresAt is null", () => {
    expect(shouldRefreshToken({ expiresAt: null })).toBe(false);
  });

  it("returns true when within the skew window", () => {
    const now = 1_000_000;
    expect(shouldRefreshToken({ expiresAt: now + 30_000, now })).toBe(true);
  });

  it("returns false when comfortably in the future", () => {
    const now = 1_000_000;
    expect(shouldRefreshToken({ expiresAt: now + 5 * 60_000, now })).toBe(false);
  });

  it("uses the documented 60s default skew", () => {
    expect(OAUTH2_REFRESH_SKEW_MS).toBe(60_000);
    const now = 1_000_000;
    expect(shouldRefreshToken({ expiresAt: now + 59_000, now })).toBe(true);
    expect(shouldRefreshToken({ expiresAt: now + 61_000, now })).toBe(false);
  });

  it("respects a custom skew", () => {
    const now = 1_000_000;
    expect(shouldRefreshToken({ expiresAt: now + 30_000, now, skewMs: 10_000 })).toBe(false);
    expect(shouldRefreshToken({ expiresAt: now + 5_000, now, skewMs: 10_000 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error type plumbing — make sure Effect propagates the tagged error
// ---------------------------------------------------------------------------

describe("OAuth2Error tagging", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("Effect failure channel carries OAuth2Error", async () => {
    const exit = await Effect.runPromiseExit(
      refreshAccessToken({
        tokenUrl: "https://example.com/token",
        clientId: "cid",
        refreshToken: "old",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // Walk the cause to find the failure
      const failures = JSON.stringify(exit.cause);
      expect(failures).toContain("OAuth2Error");
    }
  });

  it("OAuth2Error is constructable directly with message and cause", () => {
    const err = new OAuth2Error({ message: "test", cause: { foo: 1 } });
    expect(err._tag).toBe("OAuth2Error");
    expect(err.message).toBe("test");
    expect(err.cause).toEqual({ foo: 1 });
  });
});

// ---------------------------------------------------------------------------
// Fidelity tests for storeOAuthTokens + withRefreshedAccessToken.
// Uses an in-memory secrets adapter so we can assert exactly which calls
// happen in which order across the "no refresh needed", "refresh needed",
// "refresh rotates the refresh_token", and "secret resolution fails" paths.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";

import {
  OAUTH2_REFRESH_SKEW_MS,
  storeOAuthTokens,
  withRefreshedAccessToken,
  type OAuth2AuthRefs,
  type OAuth2SecretsIO,
  type RefreshedAuthSnapshot,
} from "./index";

// ---------------------------------------------------------------------------
// In-memory secrets adapter
// ---------------------------------------------------------------------------

const makeSecrets = (initial: Record<string, string>): {
  io: OAuth2SecretsIO;
  state: Map<string, { value: string; name: string; purpose: string }>;
  missing: Set<string>;
} => {
  const state = new Map<string, { value: string; name: string; purpose: string }>();
  for (const [id, v] of Object.entries(initial))
    state.set(id, { value: v, name: "", purpose: "" });
  const missing = new Set<string>();
  const io: OAuth2SecretsIO = {
    resolve: (secretId) =>
      Effect.gen(function* () {
        if (missing.has(secretId))
          return yield* Effect.fail(new Error(`secret ${secretId} not found`));
        const entry = state.get(secretId);
        if (!entry)
          return yield* Effect.fail(new Error(`secret ${secretId} not found`));
        return entry.value;
      }),
    setValue: ({ secretId, value, name, purpose }) =>
      Effect.sync(() => {
        state.set(secretId, { value, name, purpose });
      }),
  };
  return { io, state, missing };
};

// ---------------------------------------------------------------------------
// fetch capture for refresh path
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

const captureFetch = (
  response: Response | (() => Response),
): { calls: Array<{ url: string; init: RequestInit }> } => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = vi
    .fn()
    .mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return typeof response === "function" ? response() : response;
    }) as unknown as typeof fetch;
  return { calls };
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// storeOAuthTokens
// ---------------------------------------------------------------------------

describe("storeOAuthTokens", () => {
  const baseInput = {
    slug: "acme_api",
    displayName: "Acme API",
    accessTokenPurpose: "acme_oauth_access_token",
    refreshTokenPurpose: "acme_oauth_refresh_token",
  };

  it("stores both access and refresh tokens as new secrets", async () => {
    const calls: Array<{ idPrefix: string; name: string; purpose: string; value: string }> = [];
    const result = await Effect.runPromise(
      storeOAuthTokens({
        ...baseInput,
        tokens: {
          access_token: "tok",
          refresh_token: "rtok",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read write",
        },
        createSecret: (input) => {
          calls.push(input);
          return Effect.succeed({ id: `id_${calls.length}` });
        },
      }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.idPrefix).toBe("acme_api_access_token");
    expect(calls[0]!.name).toBe("Acme API Access Token");
    expect(calls[0]!.purpose).toBe("acme_oauth_access_token");
    expect(calls[0]!.value).toBe("tok");
    expect(calls[1]!.idPrefix).toBe("acme_api_refresh_token");
    expect(calls[1]!.value).toBe("rtok");
    expect(result.accessTokenSecretId).toBe("id_1");
    expect(result.refreshTokenSecretId).toBe("id_2");
    expect(result.tokenType).toBe("Bearer");
    expect(result.scope).toBe("read write");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("omits the refresh-token secret when the response did not return one", async () => {
    let calls = 0;
    const result = await Effect.runPromise(
      storeOAuthTokens({
        ...baseInput,
        tokens: { access_token: "tok" },
        createSecret: () => {
          calls++;
          return Effect.succeed({ id: `id_${calls}` });
        },
      }),
    );
    expect(calls).toBe(1);
    expect(result.refreshTokenSecretId).toBeNull();
    expect(result.tokenType).toBe("Bearer");
    expect(result.expiresAt).toBeNull();
    expect(result.scope).toBeNull();
  });

  it("wraps createSecret failure in an OAuth2Error with a descriptive message", async () => {
    const exit = await Effect.runPromiseExit(
      storeOAuthTokens({
        ...baseInput,
        tokens: { access_token: "tok", refresh_token: "rtok" },
        createSecret: () => Effect.fail(new Error("kv write failed")),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toContain("OAuth2Error");
      expect(json).toContain("Failed to store access token");
      expect(json).toContain("kv write failed");
    }
  });
});

// ---------------------------------------------------------------------------
// withRefreshedAccessToken
// ---------------------------------------------------------------------------

describe("withRefreshedAccessToken", () => {
  const makeAuth = (overrides: Partial<OAuth2AuthRefs> = {}): OAuth2AuthRefs => ({
    clientIdSecretId: "cid-secret",
    clientSecretSecretId: "csecret-secret",
    accessTokenSecretId: "atok-secret",
    refreshTokenSecretId: "rtok-secret",
    tokenType: "Bearer",
    expiresAt: null,
    scopes: ["read", "write"],
    ...overrides,
  });

  const baseInput = {
    tokenUrl: "https://api.example.com/oauth/token",
    displayName: "Acme",
    accessTokenPurpose: "acme_access",
    refreshTokenPurpose: "acme_refresh",
  };

  it("returns the current access token without refreshing when expiresAt is null", async () => {
    const { io } = makeSecrets({
      "atok-secret": "current-access-token",
      "rtok-secret": "stored-refresh",
      "cid-secret": "cid",
      "csecret-secret": "csecret",
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const persistAuth = vi.fn(() => Effect.void);

    const result = await Effect.runPromise(
      withRefreshedAccessToken({
        ...baseInput,
        auth: makeAuth({ expiresAt: null }),
        secrets: io,
        persistAuth,
      }),
    );
    expect(result).toBe("current-access-token");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(persistAuth).not.toHaveBeenCalled();
  });

  it("returns the current access token when expiresAt is comfortably in the future", async () => {
    const { io } = makeSecrets({
      "atok-secret": "current",
      "rtok-secret": "r",
      "cid-secret": "c",
      "csecret-secret": "s",
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await Effect.runPromise(
      withRefreshedAccessToken({
        ...baseInput,
        auth: makeAuth({ expiresAt: Date.now() + 10 * 60_000 }),
        secrets: io,
        persistAuth: () => Effect.void,
      }),
    );
    expect(result).toBe("current");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes when expiresAt is within the skew window, persists new token, calls persistAuth", async () => {
    const { io, state } = makeSecrets({
      "atok-secret": "old-access",
      "rtok-secret": "stored-refresh",
      "cid-secret": "client-1",
      "csecret-secret": "secret-1",
    });
    const { calls } = captureFetch(
      jsonResponse(200, {
        access_token: "new-access",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const persistedSnapshots: RefreshedAuthSnapshot[] = [];
    const persistAuth = (snapshot: RefreshedAuthSnapshot) =>
      Effect.sync(() => {
        persistedSnapshots.push(snapshot);
      });

    const result = await Effect.runPromise(
      withRefreshedAccessToken({
        ...baseInput,
        auth: makeAuth({ expiresAt: Date.now() + 30_000 }),
        secrets: io,
        persistAuth,
      }),
    );

    expect(result).toBe("new-access");
    expect(calls).toHaveLength(1);
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("stored-refresh");
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("client_secret")).toBe("secret-1");
    expect(body.get("scope")).toBe("read write");

    // Access-token secret was updated in place with the new value.
    expect(state.get("atok-secret")!.value).toBe("new-access");
    // persistAuth called with updated snapshot.
    expect(persistedSnapshots).toHaveLength(1);
    expect(persistedSnapshots[0]!.tokenType).toBe("Bearer");
    expect(persistedSnapshots[0]!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rotates the refresh_token secret when the server returns a new one", async () => {
    const { io, state } = makeSecrets({
      "atok-secret": "old",
      "rtok-secret": "old-refresh",
      "cid-secret": "c",
      "csecret-secret": "s",
    });
    captureFetch(
      jsonResponse(200, {
        access_token: "new",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    );
    await Effect.runPromise(
      withRefreshedAccessToken({
        ...baseInput,
        auth: makeAuth({ expiresAt: Date.now() + 30_000 }),
        secrets: io,
        persistAuth: () => Effect.void,
      }),
    );
    expect(state.get("rtok-secret")!.value).toBe("new-refresh");
  });

  it("does NOT touch the refresh_token secret when the server omits it", async () => {
    const { io, state } = makeSecrets({
      "atok-secret": "old",
      "rtok-secret": "old-refresh",
      "cid-secret": "c",
      "csecret-secret": "s",
    });
    captureFetch(jsonResponse(200, { access_token: "new", expires_in: 3600 }));
    await Effect.runPromise(
      withRefreshedAccessToken({
        ...baseInput,
        auth: makeAuth({ expiresAt: Date.now() + 30_000 }),
        secrets: io,
        persistAuth: () => Effect.void,
      }),
    );
    expect(state.get("rtok-secret")!.value).toBe("old-refresh");
  });

  it("skips the refresh path entirely when refreshTokenSecretId is null, even if expired", async () => {
    const { io } = makeSecrets({
      "atok-secret": "only-access",
      "cid-secret": "c",
      "csecret-secret": "s",
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await Effect.runPromise(
      withRefreshedAccessToken({
        ...baseInput,
        auth: makeAuth({
          refreshTokenSecretId: null,
          expiresAt: Date.now() - 10_000,
        }),
        secrets: io,
        persistAuth: () => Effect.void,
      }),
    );
    expect(result).toBe("only-access");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("omits client_secret from the refresh call when clientSecretSecretId is null", async () => {
    const { io } = makeSecrets({
      "atok-secret": "old",
      "rtok-secret": "rtok",
      "cid-secret": "public-client",
    });
    const { calls } = captureFetch(
      jsonResponse(200, { access_token: "new", expires_in: 3600 }),
    );
    await Effect.runPromise(
      withRefreshedAccessToken({
        ...baseInput,
        auth: makeAuth({
          clientSecretSecretId: null,
          expiresAt: Date.now() + 30_000,
        }),
        secrets: io,
        persistAuth: () => Effect.void,
      }),
    );
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("client_id")).toBe("public-client");
    expect(body.has("client_secret")).toBe(false);
  });

  it("wraps secret-resolve failures in OAuth2Error with descriptive messages", async () => {
    const { io, missing } = makeSecrets({
      "atok-secret": "old",
      "rtok-secret": "rtok",
      "cid-secret": "c",
      "csecret-secret": "s",
    });
    missing.add("rtok-secret");
    captureFetch(jsonResponse(200, { access_token: "new" }));
    const exit = await Effect.runPromiseExit(
      withRefreshedAccessToken({
        ...baseInput,
        auth: makeAuth({ expiresAt: Date.now() + 30_000 }),
        secrets: io,
        persistAuth: () => Effect.void,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toContain("OAuth2Error");
      expect(json).toContain("Failed to resolve OAuth refresh token");
    }
  });

  it("uses the default 60s refresh skew window", () => {
    expect(OAUTH2_REFRESH_SKEW_MS).toBe(60_000);
  });
});

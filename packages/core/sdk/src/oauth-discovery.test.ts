import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import {
  OAuthDiscoveryError,
  beginDynamicAuthorization,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  registerDynamicClient,
} from "./oauth-discovery";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

const installFetchRouter = (
  handlers: readonly { match: (url: string) => boolean; handle: Handler }[],
): { calls: Array<{ url: string; init: RequestInit }> } => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = vi
    .fn()
    .mockImplementation(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      for (const h of handlers) {
        if (h.match(url)) return h.handle(url, init);
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
  return { calls };
};

const originalFetch = globalThis.fetch;

describe("discoverProtectedResourceMetadata", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches RFC 9728 well-known metadata on the resource's origin", async () => {
    installFetchRouter([
      {
        match: (u) =>
          u ===
          "https://api.example.com/.well-known/oauth-protected-resource/graphql",
        handle: () => new Response(null, { status: 404 }),
      },
      {
        match: (u) =>
          u === "https://api.example.com/.well-known/oauth-protected-resource",
        handle: () =>
          new Response(
            JSON.stringify({
              resource: "https://api.example.com",
              authorization_servers: ["https://api.example.com"],
              scopes_supported: ["read"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    ]);

    const result = await Effect.runPromise(
      discoverProtectedResourceMetadata("https://api.example.com/graphql"),
    );
    expect(result).not.toBeNull();
    expect(result!.metadata.authorization_servers?.[0]).toBe(
      "https://api.example.com",
    );
    expect(result!.metadataUrl).toBe(
      "https://api.example.com/.well-known/oauth-protected-resource",
    );
  });

  it("returns null when every well-known candidate 404s", async () => {
    installFetchRouter([
      { match: () => true, handle: () => new Response(null, { status: 404 }) },
    ]);

    const result = await Effect.runPromise(
      discoverProtectedResourceMetadata("https://api.example.com/graphql"),
    );
    expect(result).toBeNull();
  });

  it("surfaces malformed metadata bodies as OAuthDiscoveryError", async () => {
    installFetchRouter([
      {
        match: () => true,
        handle: () =>
          new Response("not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    ]);
    const exit = await Effect.runPromiseExit(
      discoverProtectedResourceMetadata("https://api.example.com"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(OAuthDiscoveryError);
      }
    }
  });
});

describe("discoverAuthorizationServerMetadata", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("falls back to openid-configuration when oauth-authorization-server is absent", async () => {
    installFetchRouter([
      {
        match: (u) =>
          u === "https://as.example.com/.well-known/oauth-authorization-server",
        handle: () => new Response(null, { status: 404 }),
      },
      {
        match: (u) =>
          u === "https://as.example.com/.well-known/openid-configuration",
        handle: () =>
          new Response(
            JSON.stringify({
              issuer: "https://as.example.com",
              authorization_endpoint: "https://as.example.com/authorize",
              token_endpoint: "https://as.example.com/token",
              code_challenge_methods_supported: ["S256"],
              response_types_supported: ["code"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    ]);

    const result = await Effect.runPromise(
      discoverAuthorizationServerMetadata("https://as.example.com"),
    );
    expect(result).not.toBeNull();
    expect(result!.metadata.token_endpoint).toBe(
      "https://as.example.com/token",
    );
    expect(result!.metadataUrl.endsWith("openid-configuration")).toBe(true);
  });

  it("requires issuer + authorize + token endpoints", async () => {
    installFetchRouter([
      {
        match: () => true,
        handle: () =>
          new Response(JSON.stringify({ issuer: "https://as" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    ]);
    const exit = await Effect.runPromiseExit(
      discoverAuthorizationServerMetadata("https://as"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("registerDynamicClient", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs RFC 7591 metadata and parses the client information response", async () => {
    const { calls } = installFetchRouter([
      {
        match: (u) => u === "https://as.example.com/register",
        handle: () =>
          new Response(
            JSON.stringify({
              client_id: "generated-client-id",
              client_id_issued_at: 1_700_000_000,
              redirect_uris: ["https://app.example.com/cb"],
              token_endpoint_auth_method: "none",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      },
    ]);

    const info = await Effect.runPromise(
      registerDynamicClient({
        registrationEndpoint: "https://as.example.com/register",
        metadata: {
          redirect_uris: ["https://app.example.com/cb"],
          client_name: "Executor",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
      }),
    );
    expect(info.client_id).toBe("generated-client-id");

    const call = calls[0]!;
    expect(call.init.method).toBe("POST");
    const body = JSON.parse(call.init.body as string);
    expect(body.redirect_uris).toEqual(["https://app.example.com/cb"]);
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("surfaces AS error responses with the error body", async () => {
    installFetchRouter([
      {
        match: () => true,
        handle: () =>
          new Response(
            JSON.stringify({
              error: "invalid_client_metadata",
              error_description: "redirect_uris must be https",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      },
    ]);
    const exit = await Effect.runPromiseExit(
      registerDynamicClient({
        registrationEndpoint: "https://as/register",
        metadata: { redirect_uris: ["http://localhost/cb"] },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      if (err._tag === "Some" && err.value instanceof OAuthDiscoveryError) {
        expect(err.value.status).toBe(400);
        expect(err.value.message).toMatch(/invalid_client_metadata/);
      } else {
        throw new Error("expected OAuthDiscoveryError");
      }
    }
  });
});

describe("beginDynamicAuthorization", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // The shape Railway's backboard publishes — this locks in the
  // end-to-end flow for the concrete case that motivated the feature.
  const installRailwayLike = (): void => {
    installFetchRouter([
      {
        match: (u) =>
          u ===
          "https://backboard.railway.com/.well-known/oauth-protected-resource/graphql/v2",
        handle: () => new Response(null, { status: 404 }),
      },
      {
        match: (u) =>
          u ===
          "https://backboard.railway.com/.well-known/oauth-protected-resource",
        handle: () =>
          new Response(
            JSON.stringify({
              resource: "https://backboard.railway.com",
              authorization_servers: ["https://backboard.railway.com"],
              scopes_supported: [
                "openid",
                "profile",
                "email",
                "offline_access",
                "workspace:member",
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
      {
        match: (u) =>
          u ===
          "https://backboard.railway.com/.well-known/oauth-authorization-server",
        handle: () =>
          new Response(
            JSON.stringify({
              issuer: "https://backboard.railway.com",
              authorization_endpoint:
                "https://backboard.railway.com/oauth/auth",
              token_endpoint: "https://backboard.railway.com/oauth/token",
              registration_endpoint:
                "https://backboard.railway.com/oauth/register",
              scopes_supported: [
                "openid",
                "profile",
                "email",
                "offline_access",
                "workspace:member",
              ],
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
      {
        match: (u) => u === "https://backboard.railway.com/oauth/register",
        handle: () =>
          new Response(
            JSON.stringify({
              client_id: "dyn-client-42",
              redirect_uris: ["https://app.example/cb"],
              token_endpoint_auth_method: "none",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      },
    ]);
  };

  it("runs the full discovery + DCR + PKCE chain for a Railway-shaped endpoint", async () => {
    installRailwayLike();

    const result = await Effect.runPromise(
      beginDynamicAuthorization({
        endpoint: "https://backboard.railway.com/graphql/v2",
        redirectUrl: "https://app.example/cb",
        state: "state-xyz",
      }),
    );

    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe(
      "https://backboard.railway.com/oauth/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("dyn-client-42");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example/cb",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(result.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(result.state.authorizationServerUrl).toBe(
      "https://backboard.railway.com",
    );
    expect(result.state.authorizationServerMetadata.token_endpoint).toBe(
      "https://backboard.railway.com/oauth/token",
    );
    expect(result.state.clientInformation.client_id).toBe("dyn-client-42");
    expect(result.state.resourceMetadata?.resource).toBe(
      "https://backboard.railway.com",
    );
  });

  it("skips discovery + DCR when previousState is provided", async () => {
    const { calls } = installFetchRouter([]);

    const result = await Effect.runPromise(
      beginDynamicAuthorization({
        endpoint: "https://as.example.com/graphql",
        redirectUrl: "https://app/cb",
        state: "s",
        previousState: {
          authorizationServerUrl: "https://as.example.com",
          authorizationServerMetadataUrl:
            "https://as.example.com/.well-known/oauth-authorization-server",
          authorizationServerMetadata: {
            issuer: "https://as.example.com",
            authorization_endpoint: "https://as.example.com/authorize",
            token_endpoint: "https://as.example.com/token",
            code_challenge_methods_supported: ["S256"],
            response_types_supported: ["code"],
          },
          clientInformation: {
            client_id: "stored-client",
          },
        },
      }),
    );

    expect(calls.length).toBe(0);
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("stored-client");
  });

  it("rejects servers that don't support PKCE S256", async () => {
    installFetchRouter([
      {
        match: (u) => u.endsWith("oauth-protected-resource"),
        handle: () => new Response(null, { status: 404 }),
      },
      {
        match: (u) => u.endsWith("oauth-authorization-server"),
        handle: () =>
          new Response(
            JSON.stringify({
              issuer: "https://legacy.example.com",
              authorization_endpoint:
                "https://legacy.example.com/authorize",
              token_endpoint: "https://legacy.example.com/token",
              code_challenge_methods_supported: ["plain"],
              response_types_supported: ["code"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    ]);
    const exit = await Effect.runPromiseExit(
      beginDynamicAuthorization({
        endpoint: "https://legacy.example.com/api",
        redirectUrl: "https://app/cb",
        state: "s",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails when the authorization server has no registration_endpoint and no previous client", async () => {
    installFetchRouter([
      {
        match: (u) => u.endsWith("oauth-protected-resource"),
        handle: () => new Response(null, { status: 404 }),
      },
      {
        match: (u) => u.endsWith("oauth-authorization-server"),
        handle: () =>
          new Response(
            JSON.stringify({
              issuer: "https://static.example.com",
              authorization_endpoint:
                "https://static.example.com/authorize",
              token_endpoint: "https://static.example.com/token",
              code_challenge_methods_supported: ["S256"],
              response_types_supported: ["code"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    ]);
    const exit = await Effect.runPromiseExit(
      beginDynamicAuthorization({
        endpoint: "https://static.example.com/api",
        redirectUrl: "https://app/cb",
        state: "s",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

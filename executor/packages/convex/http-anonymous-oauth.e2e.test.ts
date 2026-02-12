import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { computeS256Challenge } from "../core/src/anonymous-oauth";

function setup() {
  return convexTest(schema, {
    "./database.ts": () => import("./database"),
    "./executor.ts": () => import("./executor"),
    "./executorNode.ts": () => import("./executorNode"),
    "./http.ts": () => import("./http"),
    "./auth.ts": () => import("./auth"),
    "./workspaceAuthInternal.ts": () => import("./workspaceAuthInternal"),
    "./workspaceToolCache.ts": () => import("./workspaceToolCache"),
    "./openApiSpecCache.ts": () => import("./openApiSpecCache"),
    "./mcpNode.ts": () => import("./mcpNode"),
    "./anonymousOauth.ts": () => import("./anonymousOauth"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function fetchViaConvexTest(
  t: ReturnType<typeof setup>,
  url: string,
  init?: RequestInit,
) {
  const parsed = new URL(url);
  return await t.fetch(`${parsed.pathname}${parsed.search}${parsed.hash}`, init);
}

test("anonymous OAuth flow binds token to workspace/session for MCP", async () => {
  const previousAnonymousOauth = process.env.MCP_ENABLE_ANONYMOUS_OAUTH;
  const previousAuthorizationServer = process.env.MCP_AUTHORIZATION_SERVER;
  process.env.MCP_ENABLE_ANONYMOUS_OAUTH = "1";
  delete process.env.MCP_AUTHORIZATION_SERVER;

  const t = setup();

  try {
    const session = await t.mutation(internal.database.bootstrapAnonymousSession, {});
    const query = new URLSearchParams({
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    }).toString();

    const protectedResourceRes = await t.fetch(`/.well-known/oauth-protected-resource?${query}`);
    expect(protectedResourceRes.status).toBe(200);
    const protectedResource = await protectedResourceRes.json() as {
      resource: string;
      authorization_servers: string[];
    };
    const protectedResourceUrl = new URL(protectedResource.resource);
    expect(protectedResourceUrl.pathname).toBe("/mcp");
    expect(protectedResourceUrl.searchParams.get("workspaceId")).toBe(session.workspaceId);
    expect(protectedResourceUrl.searchParams.get("sessionId")).toBe(session.sessionId);
    expect(protectedResource.authorization_servers.length).toBe(1);

    const authorizationServerUrl = protectedResource.authorization_servers[0]!;
    const metadataWithoutQueryRes = await fetchViaConvexTest(
      t,
      `${authorizationServerUrl}/.well-known/oauth-authorization-server`,
    );
    expect(metadataWithoutQueryRes.status).toBe(200);
    const metadataWithoutQuery = await metadataWithoutQueryRes.json() as {
      issuer: string;
    };
    expect(metadataWithoutQuery.issuer).toBe(authorizationServerUrl);

    const metadataRes = await fetchViaConvexTest(
      t,
      `${authorizationServerUrl}/.well-known/oauth-authorization-server?${query}`,
    );
    expect(metadataRes.status).toBe(200);
    const metadata = await metadataRes.json() as {
      registration_endpoint: string;
      authorization_endpoint: string;
      token_endpoint: string;
    };

    const registerRes = await fetchViaConvexTest(t, metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/callback"],
      }),
    });
    expect(registerRes.status).toBe(201);
    const registration = await registerRes.json() as { client_id: string };

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await computeS256Challenge(codeVerifier);
    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", registration.client_id);
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", protectedResource.resource);

    const authorizeRes = await fetchViaConvexTest(t, authorizeUrl.toString(), { redirect: "manual" });
    expect(authorizeRes.status).toBe(302);
    const redirectLocation = authorizeRes.headers.get("location");
    expect(redirectLocation).toBeTruthy();
    const code = new URL(redirectLocation!).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await fetchViaConvexTest(t, metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        client_id: registration.client_id,
        redirect_uri: "http://localhost:9999/callback",
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json() as { access_token: string };
    expect(tokenBody.access_token).toBeTruthy();

    const authorizedMcpRes = await t.fetch(`/mcp?${query}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(authorizedMcpRes.status).not.toBe(401);
    expect(authorizedMcpRes.status).not.toBe(403);

    const mismatchedQuery = new URLSearchParams({
      workspaceId: session.workspaceId,
      sessionId: `mcp_${crypto.randomUUID()}`,
    }).toString();
    const mismatchedMcpRes = await t.fetch(`/mcp?${mismatchedQuery}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(mismatchedMcpRes.status).toBe(401);
  } finally {
    if (previousAnonymousOauth === undefined) {
      delete process.env.MCP_ENABLE_ANONYMOUS_OAUTH;
    } else {
      process.env.MCP_ENABLE_ANONYMOUS_OAUTH = previousAnonymousOauth;
    }

    if (previousAuthorizationServer === undefined) {
      delete process.env.MCP_AUTHORIZATION_SERVER;
    } else {
      process.env.MCP_AUTHORIZATION_SERVER = previousAuthorizationServer;
    }
  }
});

test("queryless protected-resource discovery prefers anonymous auth metadata", async () => {
  const previousAnonymousOauth = process.env.MCP_ENABLE_ANONYMOUS_OAUTH;
  const previousAuthorizationServer = process.env.MCP_AUTHORIZATION_SERVER;
  process.env.MCP_ENABLE_ANONYMOUS_OAUTH = "1";
  process.env.MCP_AUTHORIZATION_SERVER = "https://victorious-point-35-staging.authkit.app";

  const t = setup();
  try {
    const res = await t.fetch("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      authorization_servers: string[];
    };
    expect(body.authorization_servers[0]).toBe("https://some.convex.site");
  } finally {
    if (previousAnonymousOauth === undefined) {
      delete process.env.MCP_ENABLE_ANONYMOUS_OAUTH;
    } else {
      process.env.MCP_ENABLE_ANONYMOUS_OAUTH = previousAnonymousOauth;
    }

    if (previousAuthorizationServer === undefined) {
      delete process.env.MCP_AUTHORIZATION_SERVER;
    } else {
      process.env.MCP_AUTHORIZATION_SERVER = previousAuthorizationServer;
    }
  }
});

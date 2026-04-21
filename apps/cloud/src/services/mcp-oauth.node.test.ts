// ---------------------------------------------------------------------------
// Cloud API × MCP OAuth — real HTTP end-to-end
// ---------------------------------------------------------------------------
//
// Drives the ProtectedCloudApi through the node-pool harness against a
// real in-process OAuth + MCP server (Node `http.createServer` bound to
// a random port). Every layer between the test and the plugin is real:
//
//   test → HttpApiClient → in-process webHandler → ProtectedCloudApi
//        → McpHandlers → mcpPlugin.startOAuth / completeOAuth
//        → MCP SDK `auth()`
//        → fake OAuth server (DCR, /authorize → 302, /token, AS metadata,
//          protected resource metadata)
//
// Two scenarios:
//
//   1. Single user: startOAuth → follow redirect → completeOAuth. Asserts
//      the response carries the Connection id the exchange minted and
//      that source-level OAuth state (clientInfo, AS URL) is echoed back
//      so subsequent users can skip DCR.
//
//   2. Two users, same source: second user's startOAuth passes the
//      clientInformation the first user's completeOAuth returned. The
//      DCR endpoint counter on the fake server must NOT tick — proof
//      the DCR-hoist code path re-uses the existing client. Both users
//      end up with their own Connection (same id, different scope) via
//      the SDK's innermost-wins shadowing.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";

import { Effect } from "effect";
import { ScopeId } from "@executor/sdk";

import { asUser, testUserOrgScopeId } from "./__test-harness__/api-harness";

// ---------------------------------------------------------------------------
// Fake OAuth + MCP server
// ---------------------------------------------------------------------------

interface FakeServer {
  readonly url: string;
  readonly registrations: () => number;
  readonly tokens: () => number;
  readonly close: () => Promise<void>;
}

const startFakeServer = async (): Promise<FakeServer> => {
  const clients = new Map<string, { redirect_uris: readonly string[] }>();
  const codes = new Map<
    string,
    { readonly clientId: string; readonly codeChallenge: string }
  >();
  const accessTokens = new Map<string, { readonly refresh: string }>();
  const refreshTokens = new Map<string, string>();
  let seq = 0;
  const next = (p: string) =>
    `${p}_${++seq}_${randomBytes(6).toString("hex")}`;
  let registrations = 0;
  let tokenCalls = 0;

  const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let buf = "";
      req.on("data", (chunk) => (buf += chunk));
      req.on("end", () => resolve(buf));
      req.on("error", reject);
    });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const send = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ) => {
      const payload =
        typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, {
        "content-type":
          typeof body === "string" ? "text/plain" : "application/json",
        ...headers,
      });
      res.end(payload);
    };

    try {
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        const origin = `http://${req.headers.host}`;
        return send(200, {
          resource: origin,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        });
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        const issuer = `http://${req.headers.host}`;
        return send(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }

      if (url.pathname === "/register" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as {
          readonly redirect_uris?: readonly string[];
          readonly grant_types?: readonly string[];
          readonly response_types?: readonly string[];
        };
        const clientId = next("client");
        clients.set(clientId, { redirect_uris: parsed.redirect_uris ?? [] });
        registrations += 1;
        return send(201, {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: parsed.redirect_uris ?? [],
          grant_types: parsed.grant_types ?? [
            "authorization_code",
            "refresh_token",
          ],
          response_types: parsed.response_types ?? ["code"],
          token_endpoint_auth_method: "none",
        });
      }

      if (url.pathname === "/authorize" && req.method === "GET") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const codeChallenge = url.searchParams.get("code_challenge") ?? "";
        const method = url.searchParams.get("code_challenge_method") ?? "";
        if (!clients.has(clientId)) {
          return send(400, { error: "unknown_client" });
        }
        if (method !== "S256" || !codeChallenge) {
          return send(400, { error: "invalid_request" });
        }
        const code = next("code");
        codes.set(code, { clientId, codeChallenge });
        const destination = new URL(redirectUri);
        destination.searchParams.set("code", code);
        if (state) destination.searchParams.set("state", state);
        return send(302, "", { location: destination.toString() });
      }

      if (url.pathname === "/token" && req.method === "POST") {
        tokenCalls += 1;
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const grant = params.get("grant_type");

        if (grant === "authorization_code") {
          const code = params.get("code") ?? "";
          const verifier = params.get("code_verifier") ?? "";
          const record = codes.get(code);
          if (!record) return send(400, { error: "invalid_grant" });
          codes.delete(code);
          const computed = createHash("sha256")
            .update(verifier)
            .digest("base64url");
          if (computed !== record.codeChallenge) {
            return send(400, { error: "invalid_grant" });
          }
          const access = next("at");
          const refresh = next("rt");
          accessTokens.set(access, { refresh });
          refreshTokens.set(refresh, access);
          return send(200, {
            access_token: access,
            refresh_token: refresh,
            token_type: "Bearer",
            expires_in: 3600,
          });
        }

        if (grant === "refresh_token") {
          const rt = params.get("refresh_token") ?? "";
          const prev = refreshTokens.get(rt);
          if (!prev) return send(400, { error: "invalid_grant" });
          refreshTokens.delete(rt);
          accessTokens.delete(prev);
          const access = next("at");
          const refresh = next("rt");
          accessTokens.set(access, { refresh });
          refreshTokens.set(refresh, access);
          return send(200, {
            access_token: access,
            refresh_token: refresh,
            token_type: "Bearer",
            expires_in: 3600,
          });
        }

        return send(400, { error: "unsupported_grant_type" });
      }

      // Default: 401 with WWW-Authenticate so any MCP probe on /mcp
      // gets the resource-metadata pointer the auth() discovery uses.
      if (url.pathname === "/mcp") {
        const origin = `http://${req.headers.host}`;
        return send(
          401,
          { error: "unauthorized" },
          {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          },
        );
      }

      send(404, { error: "not_found", path: url.pathname });
    } catch (e) {
      send(500, { error: "server_error", message: String(e) });
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    registrations: () => registrations,
    tokens: () => tokenCalls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Browser popup equivalent: GET the authorization URL, pull the code +
// state out of the 302 Location.
const followAuthorize = async (
  authorizationUrl: string,
): Promise<{ code: string; state: string }> => {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  if (!location) throw new Error("no location header on authorize redirect");
  const dest = new URL(location);
  const code = dest.searchParams.get("code");
  const state = dest.searchParams.get("state");
  if (!code || !state) throw new Error(`redirect missing code/state: ${location}`);
  return { code, state };
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let fake: FakeServer;
beforeAll(async () => {
  fake = await startFakeServer();
});
afterAll(async () => {
  await fake.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp oauth end-to-end (node pool, real OAuth + MCP server)", () => {
  it.effect(
    "startOAuth → authorize → completeOAuth writes tokens at the invoker scope",
    () =>
      Effect.gen(function* () {
        const orgId = `org_${crypto.randomUUID()}`;
        const userId = `user_${crypto.randomUUID()}`;
        const userScope = ScopeId.make(testUserOrgScopeId(userId, orgId));
        const namespace = `ns_${crypto.randomUUID().slice(0, 8)}`;
        const connectionId = `mcp-oauth2-${namespace}`;
        const redirectUrl = "http://test.local/api/mcp/oauth/callback";

        const started = yield* asUser(userId, orgId, (client) =>
          client.mcp.startOAuth({
            path: { scopeId: userScope },
            payload: {
              endpoint: `${fake.url}/mcp`,
              redirectUrl,
              connectionId,
            },
          }),
        );
        expect(started.sessionId).toMatch(/^mcp_oauth_/);

        const { code, state } = yield* Effect.promise(() =>
          followAuthorize(started.authorizationUrl),
        );
        expect(state).toBe(started.sessionId);

        const completed = yield* asUser(userId, orgId, (client) =>
          client.mcp.completeOAuth({
            path: { scopeId: userScope },
            payload: { state, code },
          }),
        );
        expect(completed.connectionId).toBe(connectionId);
        expect(completed.tokenType).toBe("Bearer");
        // DCR hoist: the source-level state the UI will persist on the
        // source's auth config, so the next user skips DCR entirely.
        expect(completed.clientInformation).not.toBeNull();
        expect(completed.authorizationServerUrl).not.toBeNull();
      }),
    30_000,
  );

  it.effect(
    "second user on same source re-uses DCR client: registration endpoint is not re-hit",
    () =>
      Effect.gen(function* () {
        const orgId = `org_${crypto.randomUUID()}`;
        const userA = `user_${crypto.randomUUID()}`;
        const userB = `user_${crypto.randomUUID()}`;
        const scopeA = ScopeId.make(testUserOrgScopeId(userA, orgId));
        const scopeB = ScopeId.make(testUserOrgScopeId(userB, orgId));
        const namespace = `ns_${crypto.randomUUID().slice(0, 8)}`;
        const connectionId = `mcp-oauth2-${namespace}`;
        const endpoint = `${fake.url}/mcp`;
        const redirectUrl = "http://test.local/api/mcp/oauth/callback";

        const regsBefore = fake.registrations();

        // --- User A: full OAuth round-trip, fresh DCR. ---
        const startedA = yield* asUser(userA, orgId, (client) =>
          client.mcp.startOAuth({
            path: { scopeId: scopeA },
            payload: {
              endpoint,
              redirectUrl,
              connectionId,
            },
          }),
        );
        const redirA = yield* Effect.promise(() =>
          followAuthorize(startedA.authorizationUrl),
        );
        const completedA = yield* asUser(userA, orgId, (client) =>
          client.mcp.completeOAuth({
            path: { scopeId: scopeA },
            payload: { state: redirA.state, code: redirA.code },
          }),
        );
        expect(completedA.connectionId).toBe(connectionId);
        expect(completedA.clientInformation).not.toBeNull();
        expect(fake.registrations()).toBe(regsBefore + 1);

        // --- User B: re-uses A's client info; DCR must NOT fire again. ---
        const startedB = yield* asUser(userB, orgId, (client) =>
          client.mcp.startOAuth({
            path: { scopeId: scopeB },
            payload: {
              endpoint,
              redirectUrl,
              connectionId,
              clientInformation: completedA.clientInformation,
              authorizationServerUrl: completedA.authorizationServerUrl,
              resourceMetadataUrl: completedA.resourceMetadataUrl,
            },
          }),
        );
        const redirB = yield* Effect.promise(() =>
          followAuthorize(startedB.authorizationUrl),
        );
        const completedB = yield* asUser(userB, orgId, (client) =>
          client.mcp.completeOAuth({
            path: { scopeId: scopeB },
            payload: { state: redirB.state, code: redirB.code },
          }),
        );
        expect(completedB.connectionId).toBe(connectionId);
        expect(fake.registrations()).toBe(regsBefore + 1);
      }),
    30_000,
  );
});

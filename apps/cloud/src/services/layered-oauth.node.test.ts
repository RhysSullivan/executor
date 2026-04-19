// Layered-scope OAuth2 integration test — cloud HTTP edition.
//
// Mirrors packages/plugins/openapi/src/sdk/layered-oauth.test.ts but
// drives the real cloud HTTP stack: the admin POSTs to
// /scopes/<orgId>/secrets via asOrg(); a member POSTs to
// /scopes/<userScopeId>/openapi/oauth/start via asUser(), reading the
// org-seeded client credentials through ScopeStack layering and landing
// the resulting access / refresh tokens at the user scope.
//
// Token endpoint is stubbed via `vi.stubGlobal("fetch", ...)` — the
// oauth2 helper uses global fetch directly (see
// packages/plugins/oauth2/src/index.ts). The harness's own client fetch
// goes through FetchHttpClient.Fetch (injected), not global fetch, so
// stubbing globalThis.fetch only intercepts the token endpoint call.

import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import { ScopeId, SecretId } from "@executor/sdk";

import { asOrg, asUser, userScopeIdFor } from "./__test-harness__/api-harness";

const TOKEN_URL = "https://idp.example.com/oauth/token";
const AUTH_URL = "https://idp.example.com/oauth/authorize";
const REDIRECT_URL = "https://app.example.com/oauth/callback";

type TokenCall = {
  readonly code: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
};

const installMockTokenEndpoint = (options: {
  readonly issueToken: (call: TokenCall) => {
    readonly access_token: string;
    readonly refresh_token?: string;
    readonly expires_in?: number;
    readonly scope?: string;
  };
}) => {
  const calls: TokenCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const u =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      if (u !== TOKEN_URL) {
        throw new Error(`unexpected fetch target: ${u}`);
      }
      const body = init?.body;
      const form =
        body instanceof URLSearchParams
          ? body
          : new URLSearchParams(typeof body === "string" ? body : "");
      const call: TokenCall = {
        code: form.get("code") ?? "",
        clientId: form.get("client_id") ?? "",
        clientSecret: form.get("client_secret"),
      };
      calls.push(call);
      const payload = options.issueToken(call);
      return new Response(
        JSON.stringify({ token_type: "Bearer", ...payload }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  return { calls };
};

describe("cloud layered OAuth (HTTP)", () => {
  let stubbed = false;
  beforeEach(() => {
    stubbed = false;
  });
  afterEach(() => {
    if (stubbed) vi.unstubAllGlobals();
  });

  it.effect(
    "org admin seeds client creds; member OAuths with them and lands tokens at user scope",
    () =>
      Effect.gen(function* () {
        const org = `org_${crypto.randomUUID()}`;
        const aliceId = `user-alice-${crypto.randomUUID().slice(0, 8)}`;
        const aliceScope = userScopeIdFor(aliceId);

        // Admin seeds shared client credentials at org scope.
        yield* asOrg(org, (client) =>
          Effect.gen(function* () {
            yield* client.secrets.set({
              path: { scopeId: ScopeId.make(org) },
              payload: {
                id: SecretId.make("shared-github-client-id"),
                name: "GitHub App Client ID",
                value: "client-id-abc",
              },
            });
            yield* client.secrets.set({
              path: { scopeId: ScopeId.make(org) },
              payload: {
                id: SecretId.make("shared-github-client-secret"),
                name: "GitHub App Client Secret",
                value: "client-secret-xyz",
              },
            });
          }),
        );

        // Member should already see those via layering (read chain
        // [user, org]) before we install the fetch stub.
        const aliceSanity = yield* asUser(org, aliceId, (client) =>
          client.secrets.resolve({
            path: {
              scopeId: ScopeId.make(aliceScope),
              secretId: SecretId.make("shared-github-client-id"),
            },
          }),
        );
        expect(aliceSanity.value).toBe("client-id-abc");

        const mock = installMockTokenEndpoint({
          issueToken: (call) => ({
            access_token: `access-for-${call.code}`,
            refresh_token: `refresh-for-${call.code}`,
            expires_in: 3600,
            scope: "repo read:user",
          }),
        });
        stubbed = true;

        // Member kicks off the OAuth flow against her user scope —
        // startOAuth reads the org's client_id via layering.
        const started = yield* asUser(org, aliceId, (client) =>
          client.openapi.startOAuth({
            path: { scopeId: ScopeId.make(aliceScope) },
            payload: {
              displayName: "GitHub",
              securitySchemeName: "githubOAuth",
              flow: "authorizationCode",
              authorizationUrl: AUTH_URL,
              tokenUrl: TOKEN_URL,
              redirectUrl: REDIRECT_URL,
              clientIdSecretId: "shared-github-client-id",
              clientSecretSecretId: "shared-github-client-secret",
              scopes: ["repo", "read:user"],
            },
          }),
        );

        const authUrl = new URL(started.authorizationUrl);
        expect(authUrl.searchParams.get("client_id")).toBe("client-id-abc");
        expect(authUrl.searchParams.get("state")).toBe(started.sessionId);

        // Exchange the auth code — token endpoint hit via stubbed fetch,
        // tokens land in alice's user scope.
        const auth = yield* asUser(org, aliceId, (client) =>
          client.openapi.completeOAuth({
            path: { scopeId: ScopeId.make(aliceScope) },
            payload: { state: started.sessionId, code: "alice-auth-code" },
          }),
        );
        expect(mock.calls).toHaveLength(1);
        expect(mock.calls[0]!.clientId).toBe("client-id-abc");
        expect(mock.calls[0]!.clientSecret).toBe("client-secret-xyz");
        expect(mock.calls[0]!.code).toBe("alice-auth-code");

        // Alice's view lists both the org-seeded creds (scopeId=org) and
        // her own newly-stored access/refresh tokens (scopeId=aliceScope).
        const aliceList = yield* asUser(org, aliceId, (client) =>
          client.secrets.list({ path: { scopeId: ScopeId.make(aliceScope) } }),
        );
        const aliceById = new Map(aliceList.map((s) => [String(s.id), s]));
        expect(aliceById.get("shared-github-client-id")?.scopeId).toBe(org);
        expect(aliceById.get("shared-github-client-secret")?.scopeId).toBe(org);
        expect(aliceById.get(auth.accessTokenSecretId)?.scopeId).toBe(aliceScope);
        if (auth.refreshTokenSecretId) {
          expect(aliceById.get(auth.refreshTokenSecretId)?.scopeId).toBe(aliceScope);
        }

        // Admin's org-scope list must not leak alice's user-scoped tokens.
        const adminList = yield* asOrg(org, (client) =>
          client.secrets.list({ path: { scopeId: ScopeId.make(org) } }),
        );
        const adminScopes = new Set(adminList.map((s) => s.scopeId));
        expect(adminScopes).not.toContain(aliceScope);
        expect(
          adminList.find((s) => s.id === auth.accessTokenSecretId),
        ).toBeUndefined();
      }),
  );

  it.effect(
    "two members of the same org get independent sessions against a shared client",
    () =>
      Effect.gen(function* () {
        const org = `org_${crypto.randomUUID()}`;
        const aliceId = `user-alice-${crypto.randomUUID().slice(0, 8)}`;
        const bobId = `user-bob-${crypto.randomUUID().slice(0, 8)}`;
        const aliceScope = userScopeIdFor(aliceId);
        const bobScope = userScopeIdFor(bobId);

        // Org admin seeds shared client id (no secret — public client).
        yield* asOrg(org, (client) =>
          client.secrets.set({
            path: { scopeId: ScopeId.make(org) },
            payload: {
              id: SecretId.make("shared-github-client-id"),
              name: "Client ID",
              value: "shared-cid",
            },
          }),
        );

        const mock = installMockTokenEndpoint({
          issueToken: (call) => ({
            access_token: `token-${call.code}`,
            refresh_token: `refresh-${call.code}`,
            expires_in: 3600,
          }),
        });
        stubbed = true;

        // Both members start their own flows — separate sessions rooted
        // at their own user scope.
        const aliceStart = yield* asUser(org, aliceId, (client) =>
          client.openapi.startOAuth({
            path: { scopeId: ScopeId.make(aliceScope) },
            payload: {
              displayName: "GitHub",
              securitySchemeName: "githubOAuth",
              flow: "authorizationCode",
              authorizationUrl: AUTH_URL,
              tokenUrl: TOKEN_URL,
              redirectUrl: REDIRECT_URL,
              clientIdSecretId: "shared-github-client-id",
              scopes: ["repo"],
            },
          }),
        );
        const bobStart = yield* asUser(org, bobId, (client) =>
          client.openapi.startOAuth({
            path: { scopeId: ScopeId.make(bobScope) },
            payload: {
              displayName: "GitHub",
              securitySchemeName: "githubOAuth",
              flow: "authorizationCode",
              authorizationUrl: AUTH_URL,
              tokenUrl: TOKEN_URL,
              redirectUrl: REDIRECT_URL,
              clientIdSecretId: "shared-github-client-id",
              scopes: ["repo"],
            },
          }),
        );

        // Alice trying to complete Bob's session against her own executor
        // must fail — her read chain is [alice, org] and doesn't include
        // bob's scope, so the session row is invisible to her.
        const aliceStealing = yield* asUser(org, aliceId, (client) =>
          client.openapi
            .completeOAuth({
              path: { scopeId: ScopeId.make(aliceScope) },
              payload: { state: bobStart.sessionId, code: "stolen" },
            })
            .pipe(Effect.either),
        );
        expect(aliceStealing._tag).toBe("Left");

        const aliceAuth = yield* asUser(org, aliceId, (client) =>
          client.openapi.completeOAuth({
            path: { scopeId: ScopeId.make(aliceScope) },
            payload: { state: aliceStart.sessionId, code: "alice-code" },
          }),
        );
        const bobAuth = yield* asUser(org, bobId, (client) =>
          client.openapi.completeOAuth({
            path: { scopeId: ScopeId.make(bobScope) },
            payload: { state: bobStart.sessionId, code: "bob-code" },
          }),
        );

        // Only the two real completions hit the token endpoint; the
        // stolen attempt fails before the exchange.
        const realCalls = mock.calls.filter(
          (c) => c.code === "alice-code" || c.code === "bob-code",
        );
        expect(realCalls).toHaveLength(2);

        // Each member sees their own tokens but not the other's.
        const aliceList = yield* asUser(org, aliceId, (client) =>
          client.secrets.list({ path: { scopeId: ScopeId.make(aliceScope) } }),
        );
        const aliceIds = new Set(aliceList.map((s) => String(s.id)));
        expect(aliceIds.has(aliceAuth.accessTokenSecretId)).toBe(true);
        expect(aliceIds.has(bobAuth.accessTokenSecretId)).toBe(false);

        const bobList = yield* asUser(org, bobId, (client) =>
          client.secrets.list({ path: { scopeId: ScopeId.make(bobScope) } }),
        );
        const bobIds = new Set(bobList.map((s) => String(s.id)));
        expect(bobIds.has(bobAuth.accessTokenSecretId)).toBe(true);
        expect(bobIds.has(aliceAuth.accessTokenSecretId)).toBe(false);

        // And the shared client id is visible to both (scopeId=org).
        expect(
          aliceList.find((s) => s.id === "shared-github-client-id")?.scopeId,
        ).toBe(org);
        expect(
          bobList.find((s) => s.id === "shared-github-client-id")?.scopeId,
        ).toBe(org);
      }),
  );
});

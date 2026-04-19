// ---------------------------------------------------------------------------
// Layered-scope OAuth2 integration test.
//
// Scenario: an org admin seeds shared OAuth client credentials at the
// org scope. A member of that org initiates an OAuth flow against a
// third-party provider; the flow reads the org's client credentials
// (via layered-scope resolution) but lands the per-user access /
// refresh tokens in the member's own scope. Two members of the same
// org end up with independent sessions against a shared client.
//
// This exercises, end to end:
//   - SDK layered scope (executor.secrets.get falls through user → org)
//   - Per-user write isolation (startOAuth's session row + completeOAuth's
//     stored tokens land at the user scope, never the org scope)
//   - Plugin-level OAuth flow (startOAuth → authorization URL builder →
//     completeOAuth → exchangeAuthorizationCode → storeOAuthTokens)
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "@effect/platform";

import { makeMemoryAdapter } from "@executor/storage-core/testing/memory";
import {
  collectSchemas,
  createExecutor,
  definePlugin,
  makeInMemoryBlobStore,
  makeLayeredTestConfig,
  makeTestScope,
  SecretId,
  SetSecretInput,
  type SecretProvider,
} from "@executor/sdk";

import { openApiPlugin } from "./plugin";

// ---------------------------------------------------------------------------
// Scope-aware in-memory provider. Models a real per-scope vault (keychain,
// WorkOS Vault) where each scope has its own keyspace but one physical
// backend. Writes land in the caller's `writeScope`; reads walk
// `readScopes` innermost-first so a user-first executor can resolve an
// org-scoped secret. `list()` only enumerates the executor's own read
// chain — it never leaks keys from scopes the caller shouldn't see.
// ---------------------------------------------------------------------------

const makeScopedProvider = (options: {
  readonly store: Map<string, string>;
  readonly readScopes: readonly string[];
  readonly writeScope: string;
}): SecretProvider => {
  const key = (scope: string, id: string) => `${scope}::${id}`;
  return {
    key: "memory",
    writable: true,
    get: (id) =>
      Effect.sync(() => {
        for (const scope of options.readScopes) {
          const v = options.store.get(key(scope, id));
          if (v !== undefined) return v;
        }
        return null;
      }),
    set: (id, value) =>
      Effect.sync(() => {
        options.store.set(key(options.writeScope, id), value);
      }),
    delete: (id) =>
      Effect.sync(() => options.store.delete(key(options.writeScope, id))),
    list: () =>
      Effect.sync(() => {
        const seen = new Set<string>();
        const out: { id: string; name: string }[] = [];
        for (const scope of options.readScopes) {
          const prefix = `${scope}::`;
          for (const k of options.store.keys()) {
            if (!k.startsWith(prefix)) continue;
            const id = k.slice(prefix.length);
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id, name: id });
          }
        }
        return out;
      }),
  };
};

const scopedSecretsPlugin = (options: {
  readonly store: Map<string, string>;
  readonly readScopes: readonly string[];
  readonly writeScope: string;
}) =>
  definePlugin(() => ({
    id: "memory-secrets" as const,
    storage: () => ({}),
    secretProviders: [makeScopedProvider(options)],
  }));

// ---------------------------------------------------------------------------
// Mock token endpoint. The oauth2 helper uses global `fetch` directly
// (intentionally — it posts form-encoded bodies and doesn't need the
// Effect HttpClient infrastructure), so we stub fetch for the duration
// of each test and hand back per-call token payloads.
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://idp.example.com/oauth/token";
const AUTH_URL = "https://idp.example.com/oauth/authorize";
const REDIRECT_URL = "https://app.example.com/oauth/callback";

type TokenCall = {
  readonly code: string;
  readonly clientId: string;
  readonly clientSecret?: string | null;
};

const installMockTokenEndpoint = (options: {
  readonly issueToken: (call: TokenCall) => {
    readonly access_token: string;
    readonly refresh_token?: string;
    readonly expires_in?: number;
    readonly scope?: string;
    readonly token_type?: string;
  };
}) => {
  const calls: TokenCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (
      url: string | URL,
      init?: { method?: string; body?: BodyInit | null },
    ) => {
      const u = typeof url === "string" ? url : url.toString();
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
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );
  return { calls };
};

// ---------------------------------------------------------------------------
// Executor factory. One backing adapter + blob store shared across the
// admin + member executors so writes at one scope are visible (filtered
// by scope_id) to the other.
// ---------------------------------------------------------------------------

const makeBacking = () => {
  const schema = collectSchemas([
    openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
    scopedSecretsPlugin({
      store: new Map(),
      readScopes: [],
      writeScope: "",
    })(),
  ]);
  return {
    adapter: makeMemoryAdapter({ schema }),
    blobs: makeInMemoryBlobStore(),
  };
};

describe("layered scope: shared OAuth credentials, per-user sessions", () => {
  let stubbedFetch = false;
  beforeEach(() => {
    stubbedFetch = false;
  });
  afterEach(() => {
    if (stubbedFetch) vi.unstubAllGlobals();
  });

  it.effect(
    "org admin seeds client-id; member consumes it and lands tokens at user scope",
    () =>
      Effect.gen(function* () {
        const org = makeTestScope("org-acme", "Acme");
        const member = makeTestScope("user-alice", "Alice");

        const backing = makeBacking();
        const store = new Map<string, string>();

        // ------------------------------------------------------------------
        // 1. Org admin executor — single-scope [org], writes at org.
        // ------------------------------------------------------------------
        const adminExec = yield* createExecutor(
          makeLayeredTestConfig({
            read: [org],
            plugins: [
              openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
              scopedSecretsPlugin({
                store,
                readScopes: [org.id],
                writeScope: org.id,
              })(),
            ] as const,
            sharedBacking: backing,
          }),
        );

        // Admin stores the shared OAuth application credentials. These
        // represent the client-id / client-secret Acme registered with
        // the third-party IdP and now wants every member to OAuth against.
        yield* adminExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("shared-github-client-id"),
            name: "GitHub App Client ID",
            value: "client-id-abc",
          }),
        );
        yield* adminExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("shared-github-client-secret"),
            name: "GitHub App Client Secret",
            value: "client-secret-xyz",
          }),
        );

        // ------------------------------------------------------------------
        // 2. Member executor — [member, org], writes at member. Reads
        //    fall through to org for rows the member hasn't overridden.
        // ------------------------------------------------------------------
        const memberExec = yield* createExecutor(
          makeLayeredTestConfig({
            read: [member, org],
            plugins: [
              openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
              scopedSecretsPlugin({
                store,
                readScopes: [member.id, org.id],
                writeScope: member.id,
              })(),
            ] as const,
            sharedBacking: backing,
          }),
        );

        // Sanity: member can resolve the org-seeded secret via layering.
        expect(
          yield* memberExec.secrets.get("shared-github-client-id"),
        ).toBe("client-id-abc");

        // ------------------------------------------------------------------
        // 3. Install mock token endpoint and kick off the member's flow.
        // ------------------------------------------------------------------
        const mock = installMockTokenEndpoint({
          issueToken: (call) => ({
            access_token: `access-for-${call.code}`,
            refresh_token: `refresh-for-${call.code}`,
            expires_in: 3600,
            scope: "repo read:user",
          }),
        });
        stubbedFetch = true;

        const started = yield* memberExec.openapi.startOAuth({
          displayName: "GitHub",
          securitySchemeName: "githubOAuth",
          flow: "authorizationCode",
          authorizationUrl: AUTH_URL,
          tokenUrl: TOKEN_URL,
          redirectUrl: REDIRECT_URL,
          clientIdSecretId: "shared-github-client-id",
          clientSecretSecretId: "shared-github-client-secret",
          scopes: ["repo", "read:user"],
        });

        const authUrl = new URL(started.authorizationUrl);
        // Authorization URL carries the org's client id — member
        // successfully read across the chain.
        expect(authUrl.searchParams.get("client_id")).toBe("client-id-abc");
        expect(authUrl.searchParams.get("state")).toBe(started.sessionId);

        // ------------------------------------------------------------------
        // 4. Simulate the browser redirect: IdP returns an auth code;
        //    member's completeOAuth exchanges it for tokens.
        // ------------------------------------------------------------------
        const auth = yield* memberExec.openapi.completeOAuth({
          state: started.sessionId,
          code: "alice-auth-code",
        });

        expect(mock.calls).toHaveLength(1);
        expect(mock.calls[0]!.code).toBe("alice-auth-code");
        expect(mock.calls[0]!.clientId).toBe("client-id-abc");
        expect(mock.calls[0]!.clientSecret).toBe("client-secret-xyz");

        // ------------------------------------------------------------------
        // 5. Assert scope isolation.
        // ------------------------------------------------------------------
        // Member's view contains both the org-seeded client credentials
        // (via layering) AND their own newly-stored access/refresh tokens.
        const memberList = yield* memberExec.secrets.list();
        const memberById = new Map(memberList.map((s) => [String(s.id), s]));
        expect(memberById.get("shared-github-client-id")?.scopeId).toBe(org.id);
        expect(memberById.get("shared-github-client-secret")?.scopeId).toBe(
          org.id,
        );
        expect(memberById.get(auth.accessTokenSecretId)?.scopeId).toBe(
          member.id,
        );
        if (auth.refreshTokenSecretId) {
          expect(memberById.get(auth.refreshTokenSecretId)?.scopeId).toBe(
            member.id,
          );
        }

        // Admin (single-scope [org]) must not see any user-scoped token.
        const adminList = yield* adminExec.secrets.list();
        const adminScopes = new Set(adminList.map((s) => s.scopeId));
        expect(adminScopes).not.toContain(member.id);
        expect(
          adminList.find((s) => s.id === auth.accessTokenSecretId),
        ).toBeUndefined();
      }),
  );

  it.effect(
    "two members of the same org get independent sessions against a shared client",
    () =>
      Effect.gen(function* () {
        const org = makeTestScope("org-acme");
        const alice = makeTestScope("user-alice");
        const bob = makeTestScope("user-bob");

        const backing = makeBacking();
        const store = new Map<string, string>();

        const admin = yield* createExecutor(
          makeLayeredTestConfig({
            read: [org],
            plugins: [
              openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
              scopedSecretsPlugin({
                store,
                readScopes: [org.id],
                writeScope: org.id,
              })(),
            ] as const,
            sharedBacking: backing,
          }),
        );
        yield* admin.secrets.set(
          new SetSecretInput({
            id: SecretId.make("shared-github-client-id"),
            name: "Client ID",
            value: "shared-cid",
          }),
        );

        const makeMemberExec = (user: ReturnType<typeof makeTestScope>) =>
          createExecutor(
            makeLayeredTestConfig({
              read: [user, org],
              plugins: [
                openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
                scopedSecretsPlugin({
                  store,
                  readScopes: [user.id, org.id],
                  writeScope: user.id,
                })(),
              ] as const,
              sharedBacking: backing,
            }),
          );

        const aliceExec = yield* makeMemberExec(alice);
        const bobExec = yield* makeMemberExec(bob);

        const mock = installMockTokenEndpoint({
          issueToken: (call) => ({
            access_token: `token-${call.code}`,
            refresh_token: `refresh-${call.code}`,
            expires_in: 3600,
          }),
        });
        stubbedFetch = true;

        const aliceStart = yield* aliceExec.openapi.startOAuth({
          displayName: "GitHub",
          securitySchemeName: "githubOAuth",
          flow: "authorizationCode",
          authorizationUrl: AUTH_URL,
          tokenUrl: TOKEN_URL,
          redirectUrl: REDIRECT_URL,
          clientIdSecretId: "shared-github-client-id",
          scopes: ["repo"],
        });
        const bobStart = yield* bobExec.openapi.startOAuth({
          displayName: "GitHub",
          securitySchemeName: "githubOAuth",
          flow: "authorizationCode",
          authorizationUrl: AUTH_URL,
          tokenUrl: TOKEN_URL,
          redirectUrl: REDIRECT_URL,
          clientIdSecretId: "shared-github-client-id",
          scopes: ["repo"],
        });

        // Sessions are per-user; alice trying to complete bob's flow
        // against her own executor must fail (her read chain doesn't
        // include bob's scope).
        const aliceStealing = yield* aliceExec.openapi
          .completeOAuth({ state: bobStart.sessionId, code: "stolen" })
          .pipe(Effect.flip);
        expect(aliceStealing._tag).toBe("OpenApiOAuthError");

        // Both members complete their own flows.
        const aliceAuth = yield* aliceExec.openapi.completeOAuth({
          state: aliceStart.sessionId,
          code: "alice-code",
        });
        const bobAuth = yield* bobExec.openapi.completeOAuth({
          state: bobStart.sessionId,
          code: "bob-code",
        });

        // Token endpoint was hit for each real completion (plus nothing
        // for the stolen attempt, which fails before hitting the endpoint).
        const realCalls = mock.calls.filter(
          (c) => c.code === "alice-code" || c.code === "bob-code",
        );
        expect(realCalls).toHaveLength(2);

        // Alice's access-token metadata lives at alice's scope only;
        // bob's at bob's. Neither member sees the other's tokens.
        const aliceList = yield* aliceExec.secrets.list();
        const aliceIds = new Set(aliceList.map((s) => String(s.id)));
        expect(aliceIds.has(aliceAuth.accessTokenSecretId)).toBe(true);
        expect(aliceIds.has(bobAuth.accessTokenSecretId)).toBe(false);

        const bobList = yield* bobExec.secrets.list();
        const bobIds = new Set(bobList.map((s) => String(s.id)));
        expect(bobIds.has(bobAuth.accessTokenSecretId)).toBe(true);
        expect(bobIds.has(aliceAuth.accessTokenSecretId)).toBe(false);

        // And the shared client-id is visible to both (scoped at org).
        expect(
          aliceList.find((s) => s.id === "shared-github-client-id")?.scopeId,
        ).toBe(org.id);
        expect(
          bobList.find((s) => s.id === "shared-github-client-id")?.scopeId,
        ).toBe(org.id);
      }),
  );
});

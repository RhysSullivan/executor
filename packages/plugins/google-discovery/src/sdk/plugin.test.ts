import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import {
  ConnectionId,
  CreateConnectionInput,
  createExecutor,
  makeTestConfig,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  TokenMaterial,
  type InvokeOptions,
} from "@executor/sdk";

import { googleDiscoveryPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

const fixturePath = resolve(__dirname, "../../fixtures/drive.json");
const fixtureText = readFileSync(fixturePath, "utf8");

// ---------------------------------------------------------------------------
// Test HTTP server — serves the discovery document and echoes API calls.
// ---------------------------------------------------------------------------

interface ServerHandle {
  readonly baseUrl: string;
  readonly discoveryUrl: string;
  readonly requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>;
  readonly close: () => Promise<void>;
}

const startServer = (): Promise<ServerHandle> =>
  new Promise((resolvePromise, rejectPromise) => {
    const requests: ServerHandle["requests"] = [];

    const server: Server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const url = request.url ?? "/";

      requests.push({
        method: request.method ?? "GET",
        url,
        headers: request.headers,
        body,
      });

      if (url === "/$discovery/rest?version=v3") {
        const address = server.address();
        if (!address || typeof address === "string") {
          response.statusCode = 500;
          response.end();
          return;
        }
        const dynamicFixture = JSON.stringify({
          ...JSON.parse(fixtureText),
          rootUrl: `http://127.0.0.1:${address.port}/`,
        });
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(dynamicFixture);
        return;
      }

      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "123", name: "Quarterly Plan" }));
    });

    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("Failed to resolve test server address"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolvePromise({
        baseUrl,
        discoveryUrl: `${baseUrl}/$discovery/rest?version=v3`,
        requests,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });

// ---------------------------------------------------------------------------
// Memory secret provider plugin — lets the test store secrets with
// `executor.secrets.set` / `ctx.secrets.set`. Without this there's no
// writable provider registered against the test executor.
// ---------------------------------------------------------------------------

import { definePlugin, type SecretProvider } from "@executor/sdk";

const makeMemorySecretsPlugin = () => {
  const store = new Map<string, string>();
  const provider: SecretProvider = {
    key: "memory",
    writable: true,
    get: (id, scope) =>
      Effect.sync(() => store.get(`${scope}\u0000${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}\u0000${id}`, value);
      }),
    delete: (id, scope) =>
      Effect.sync(() => store.delete(`${scope}\u0000${id}`)),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((k) => {
          const name = k.split("\u0000", 2)[1] ?? k;
          return { id: name, name };
        }),
      ),
  };
  return definePlugin(() => ({
    id: "memory-secrets" as const,
    storage: () => ({}),
    secretProviders: [provider],
  }));
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Google Discovery plugin", () => {
  it.effect("normalizes legacy googleapis discovery urls", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
        }),
      );

      const originalFetch = globalThis.fetch;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(((
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url === "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest") {
          return Promise.resolve(
            new Response(fixtureText, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return originalFetch(input, init);
      }) as typeof fetch);

      try {
        const result = yield* executor.googleDiscovery.probeDiscovery(
          "https://drive.googleapis.com/$discovery/rest?version=v3",
        );
        expect(result.service).toBe("drive");
        expect(fetchMock).toHaveBeenCalledWith(
          "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      } finally {
        fetchMock.mockRestore();
        yield* executor.close();
      }
    }),
  );

  it.effect("starts oauth using discovery scopes", () =>
    Effect.gen(function* () {
      const handle = yield* Effect.promise(() => startServer());
      try {
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        );

        yield* executor.secrets.set(
          new SetSecretInput({
            id: SecretId.make("google-client-id"),
            scope: "test-scope" as SetSecretInput["scope"],
            name: "Google Client ID",
            value: "client-123",
          }),
        );

        const result = yield* executor.googleDiscovery.startOAuth({
          name: "Google Drive",
          discoveryUrl: handle.discoveryUrl,
          clientIdSecretId: "google-client-id",
          redirectUrl: "http://localhost/callback",
        });

        const authorizationUrl = new URL(result.authorizationUrl);
        expect(result.scopes).toContain("https://www.googleapis.com/auth/drive");
        expect(authorizationUrl.searchParams.get("client_id")).toBe("client-123");
        expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
        expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");

        yield* executor.close();
      } finally {
        yield* Effect.promise(() => handle.close());
      }
    }),
  );

  it.effect("completes oauth and stores token secrets", () =>
    Effect.gen(function* () {
      const handle = yield* Effect.promise(() => startServer());
      try {
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        );

        yield* executor.secrets.set(
          new SetSecretInput({
            id: SecretId.make("google-client-id"),
            scope: "test-scope" as SetSecretInput["scope"],
            name: "Google Client ID",
            value: "client-123",
          }),
        );
        yield* executor.secrets.set(
          new SetSecretInput({
            id: SecretId.make("google-client-secret"),
            scope: "test-scope" as SetSecretInput["scope"],
            name: "Google Client Secret",
            value: "client-secret-value",
          }),
        );

        const originalFetch = globalThis.fetch;
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(((
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (url === "https://oauth2.googleapis.com/token") {
            expect(init?.method).toBe("POST");
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  access_token: "access-token-value",
                  refresh_token: "refresh-token-value",
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: "https://www.googleapis.com/auth/drive",
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }
          return originalFetch(input, init);
        }) as typeof fetch);

        try {
          const started = yield* executor.googleDiscovery.startOAuth({
            name: "Google Drive",
            discoveryUrl: handle.discoveryUrl,
            clientIdSecretId: "google-client-id",
            clientSecretSecretId: "google-client-secret",
            redirectUrl: "http://localhost/callback",
          });

          const auth = yield* executor.googleDiscovery.completeOAuth({
            state: started.sessionId,
            code: "code-123",
          });

          expect(auth.kind).toBe("oauth2");
          expect(auth.connectionId).toMatch(/^google-discovery-oauth2-/);

          // Tokens live on the SDK connection — resolving via
          // ctx.connections.accessToken returns the minted value.
          const accessToken = yield* executor.connections.accessToken(
            auth.connectionId as Parameters<typeof executor.connections.accessToken>[0],
          );
          expect(accessToken).toBe("access-token-value");

          // Backing access-token secret is owned by the connection, so
          // it's filtered out of the user-facing secret list.
          const secretIds = new Set(
            (yield* executor.secrets.list()).map((s) => s.id as unknown as string),
          );
          expect(secretIds).not.toContain(`${auth.connectionId}.access_token`);
          expect(secretIds).not.toContain(`${auth.connectionId}.refresh_token`);
        } finally {
          fetchMock.mockRestore();
          yield* executor.close();
        }
      } finally {
        yield* Effect.promise(() => handle.close());
      }
    }),
  );

  it.effect("registers and invokes google discovery tools with oauth headers", () =>
    Effect.gen(function* () {
      const handle = yield* Effect.promise(() => startServer());
      try {
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        );

        try {
          // A connection wraps the access token (+ optional refresh) and
          // the invoke path resolves via ctx.connections.accessToken.
          const connectionId = ConnectionId.make(
            "google-discovery-oauth2-test",
          );
          yield* executor.connections.create(
            new CreateConnectionInput({
              id: connectionId,
              scope: ScopeId.make("test-scope"),
              provider: "google-discovery:oauth2",
              identityLabel: "Drive Test",
              accessToken: new TokenMaterial({
                secretId: SecretId.make(`${connectionId}.access_token`),
                name: "Drive Access Token",
                value: "secret-token",
              }),
              refreshToken: null,
              expiresAt: null,
              oauthScope: null,
              providerState: {
                clientIdSecretId: "drive-client-id",
                clientSecretSecretId: null,
                scopes: ["https://www.googleapis.com/auth/drive.readonly"],
              },
            }),
          );

          const result = yield* executor.googleDiscovery.addSource({
            name: "Google Drive",
            scope: "test-scope",
            discoveryUrl: handle.discoveryUrl,
            namespace: "drive",
            auth: {
              kind: "oauth2",
              connectionId,
              clientIdSecretId: "drive-client-id",
              clientSecretSecretId: null,
              scopes: ["https://www.googleapis.com/auth/drive.readonly"],
            },
          });

          expect(result.toolCount).toBe(2);

          const invocation = (yield* executor.tools.invoke(
            "drive.files.get",
            { fileId: "123", fields: "id,name", prettyPrint: true },
            autoApprove,
          )) as { data: unknown; error: unknown };

          expect(invocation.error).toBeNull();
          expect(invocation.data).toEqual({ id: "123", name: "Quarterly Plan" });

          const apiRequest = handle.requests.find((request) =>
            request.url.startsWith("/drive/v3/files/123"),
          );
          expect(apiRequest).toBeDefined();
          expect(apiRequest!.headers.authorization).toBe("Bearer secret-token");
          expect(apiRequest!.url).toContain("fields=id%2Cname");
          expect(apiRequest!.url).toContain("prettyPrint=true");
        } finally {
          yield* executor.close();
        }
      } finally {
        yield* Effect.promise(() => handle.close());
      }
    }),
  );

  // -------------------------------------------------------------------------
  // Multi-scope shadowing — regression suite covering the bug class where
  // store reads/writes that don't pin scope_id collapse onto whichever row
  // the scoped adapter's `scope_id IN (stack)` filter sees first. Each
  // scenario is reproducible against the pre-fix store.
  // -------------------------------------------------------------------------

  const ORG_SCOPE = ScopeId.make("org-scope");
  const USER_SCOPE = ScopeId.make("user-scope");

  const stackedScopes = [
    new Scope({ id: USER_SCOPE, name: "user", createdAt: new Date() }),
    new Scope({ id: ORG_SCOPE, name: "org", createdAt: new Date() }),
  ] as const;

  it.effect("shadowed addSource does not wipe the outer-scope source", () =>
    Effect.gen(function* () {
      const handle = yield* Effect.promise(() => startServer());
      try {
        const executor = yield* createExecutor(
          makeTestConfig({
            scopes: stackedScopes,
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        );
        try {
          // Org-level base source
          yield* executor.googleDiscovery.addSource({
            name: "Org Drive",
            scope: ORG_SCOPE as string,
            discoveryUrl: handle.discoveryUrl,
            namespace: "shared",
            auth: { kind: "none" },
          });

          // Per-user shadow with the same namespace
          yield* executor.googleDiscovery.addSource({
            name: "User Drive",
            scope: USER_SCOPE as string,
            discoveryUrl: handle.discoveryUrl,
            namespace: "shared",
            auth: { kind: "none" },
          });

          const userView = yield* executor.googleDiscovery.getSource(
            "shared",
            USER_SCOPE as string,
          );
          const orgView = yield* executor.googleDiscovery.getSource(
            "shared",
            ORG_SCOPE as string,
          );

          // Both rows must coexist — innermost-wins reads come from the
          // executor; the store's scope-pinned getters return the exact row.
          expect(userView?.name).toBe("User Drive");
          expect(userView?.scope).toBe(USER_SCOPE as string);
          expect(orgView?.name).toBe("Org Drive");
          expect(orgView?.scope).toBe(ORG_SCOPE as string);
        } finally {
          yield* executor.close();
        }
      } finally {
        yield* Effect.promise(() => handle.close());
      }
    }),
  );

  it.effect("removeSource on user shadow leaves the org row intact", () =>
    Effect.gen(function* () {
      const handle = yield* Effect.promise(() => startServer());
      try {
        const executor = yield* createExecutor(
          makeTestConfig({
            scopes: stackedScopes,
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        );
        try {
          yield* executor.googleDiscovery.addSource({
            name: "Org Drive",
            scope: ORG_SCOPE as string,
            discoveryUrl: handle.discoveryUrl,
            namespace: "shared",
            auth: { kind: "none" },
          });
          yield* executor.googleDiscovery.addSource({
            name: "User Drive",
            scope: USER_SCOPE as string,
            discoveryUrl: handle.discoveryUrl,
            namespace: "shared",
            auth: { kind: "none" },
          });

          yield* executor.googleDiscovery.removeSource(
            "shared",
            USER_SCOPE as string,
          );

          const userView = yield* executor.googleDiscovery.getSource(
            "shared",
            USER_SCOPE as string,
          );
          const orgView = yield* executor.googleDiscovery.getSource(
            "shared",
            ORG_SCOPE as string,
          );

          expect(userView).toBeNull();
          expect(orgView?.name).toBe("Org Drive");
        } finally {
          yield* executor.close();
        }
      } finally {
        yield* Effect.promise(() => handle.close());
      }
    }),
  );

  it.effect("re-adding a user shadow does not wipe the org row's bindings", () =>
    Effect.gen(function* () {
      const handle = yield* Effect.promise(() => startServer());
      try {
        const executor = yield* createExecutor(
          makeTestConfig({
            scopes: stackedScopes,
            plugins: [makeMemorySecretsPlugin()(), googleDiscoveryPlugin()] as const,
          }),
        );
        try {
          yield* executor.googleDiscovery.addSource({
            name: "Org Drive",
            scope: ORG_SCOPE as string,
            discoveryUrl: handle.discoveryUrl,
            namespace: "shared",
            auth: { kind: "none" },
          });
          // Add user shadow, then add it again — the internal
          // registerManifest sequence does a scope-pinned
          // removeBindingsBySource before re-upserting. Without pinning
          // scope, the inner re-add would wipe the org-level bindings
          // via fall-through.
          yield* executor.googleDiscovery.addSource({
            name: "User Drive v1",
            scope: USER_SCOPE as string,
            discoveryUrl: handle.discoveryUrl,
            namespace: "shared",
            auth: { kind: "none" },
          });
          yield* executor.googleDiscovery.addSource({
            name: "User Drive v2",
            scope: USER_SCOPE as string,
            discoveryUrl: handle.discoveryUrl,
            namespace: "shared",
            auth: { kind: "none" },
          });

          const userView = yield* executor.googleDiscovery.getSource(
            "shared",
            USER_SCOPE as string,
          );
          const orgView = yield* executor.googleDiscovery.getSource(
            "shared",
            ORG_SCOPE as string,
          );

          expect(userView?.name).toBe("User Drive v2");
          expect(userView?.scope).toBe(USER_SCOPE as string);
          expect(orgView?.name).toBe("Org Drive");
          expect(orgView?.scope).toBe(ORG_SCOPE as string);
        } finally {
          yield* executor.close();
        }
      } finally {
        yield* Effect.promise(() => handle.close());
      }
    }),
  );
});

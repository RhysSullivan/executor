// ---------------------------------------------------------------------------
// Local app × MCP OAuth — real HTTP end-to-end
// ---------------------------------------------------------------------------
//
// Mirrors apps/cloud/src/services/mcp-oauth.node.test.ts but for the local
// (sqlite) server. Drives the real LocalApi (core + mcp groups) against a
// real in-process OAuth + MCP server. Every layer between the test and the
// plugin is real:
//
//   test → HttpApiClient → in-process webHandler → LocalApi
//        → McpHandlers → mcpPlugin.startOAuth / completeOAuth
//        → MCP SDK `auth()`
//        → fake OAuth server (DCR, /authorize → 302, /token, AS metadata,
//          protected resource metadata)
//
// Single-scope: local has one scope per project (`${folder}-${hash}`) so
// the OAuth flow lands tokens at that scope and `secrets.resolve` reads
// them back through the same provider (file-secrets in a tmpdir).
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import {
  FetchHttpClient,
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
} from "@effect/platform";
import { Effect, Layer } from "effect";

import {
  addGroup,
  InternalError,
  observabilityMiddleware,
} from "@executor/api";
import {
  CoreHandlers,
  ExecutionEngineService,
  ExecutorService,
} from "@executor/api/server";
import { createExecutionEngine } from "@executor/execution";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";
import {
  Scope,
  ScopeId,
  SecretId,
  collectSchemas,
  createExecutor,
} from "@executor/sdk";
import {
  makeSqliteAdapter,
  makeSqliteBlobStore,
} from "@executor/storage-file";
import { fileSecretsPlugin } from "@executor/plugin-file-secrets";
import { mcpPlugin } from "@executor/plugin-mcp";
import {
  McpExtensionService,
  McpGroup,
  McpHandlers,
} from "@executor/plugin-mcp/api";

import * as executorSchema from "./executor-schema";
import { ErrorCaptureLive } from "./observability";

// Shape of the test API: core + mcp group, with InternalError surfaced at
// the top level so `observabilityMiddleware` can land its typed-error
// bridge on every endpoint.
const TestApi = addGroup(McpGroup).addError(InternalError);
type TestApiShape = typeof TestApi extends HttpApi.HttpApi<
  infer _Id,
  infer Groups,
  infer ApiError,
  infer _ApiR
>
  ? HttpApiClient.Client<Groups, ApiError, never>
  : never;

// ---------------------------------------------------------------------------
// Fake OAuth + MCP server (mirrors the cloud test)
// ---------------------------------------------------------------------------

interface FakeServer {
  readonly url: string;
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
      const payload = typeof body === "string" ? body : JSON.stringify(body);
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

        return send(400, { error: "unsupported_grant_type" });
      }

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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

// ---------------------------------------------------------------------------
// In-process local API harness — tmpdir sqlite + minimal plugin set.
// ---------------------------------------------------------------------------

const TEST_BASE_URL = "http://local.test";
const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");

interface Harness {
  readonly fetch: typeof globalThis.fetch;
  readonly scopeId: string;
  readonly dispose: () => Promise<void>;
}

const startHarness = async (tmpDir: string): Promise<Harness> => {
  const sqlite = new Database(join(tmpDir, "data.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite, { schema: executorSchema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const scopeId = `test-${randomBytes(4).toString("hex")}`;
  const plugins = [
    mcpPlugin({ dangerouslyAllowStdioMCP: false }),
    fileSecretsPlugin({ directory: tmpDir }),
  ] as const;
  const schema = collectSchemas(plugins);
  const adapter = makeSqliteAdapter({ db, schema });
  const blobs = makeSqliteBlobStore({ db });

  const scope = new Scope({
    id: ScopeId.make(scopeId),
    name: "test",
    createdAt: new Date(),
  });

  const executor = await Effect.runPromise(
    createExecutor({ scopes: [scope], adapter, blobs, plugins }),
  );

  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeQuickJsExecutor(),
  });

  const TestObservability = observabilityMiddleware(TestApi);

  const TestApiBase = HttpApiBuilder.api(TestApi).pipe(
    Layer.provide(CoreHandlers),
    Layer.provide(McpHandlers),
    Layer.provide(TestObservability),
    Layer.provide(ErrorCaptureLive),
  );

  const pluginExtensions = Layer.succeed(McpExtensionService, executor.mcp);

  const { handler: webHandler, dispose: disposeHandler } =
    HttpApiBuilder.toWebHandler(
      TestApiBase.pipe(
        Layer.provideMerge(pluginExtensions),
        Layer.provideMerge(Layer.succeed(ExecutorService, executor)),
        Layer.provideMerge(Layer.succeed(ExecutionEngineService, engine)),
        Layer.provideMerge(HttpServer.layerContext),
        Layer.provideMerge(HttpRouter.setRouterConfig({ maxParamLength: 1000 })),
      ),
      { middleware: HttpMiddleware.logger },
    );

  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      webHandler(
        input instanceof Request ? input : new Request(input, init),
      )) as typeof globalThis.fetch,
    scopeId,
    dispose: async () => {
      await disposeHandler().catch(() => undefined);
      await Effect.runPromise(executor.close()).catch(() => undefined);
      sqlite.close();
    },
  };
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let fake: FakeServer;
let tmpDir: string;
let harness: Harness;

beforeAll(async () => {
  fake = await startFakeServer();
  tmpDir = mkdtempSync(join(tmpdir(), "executor-local-mcp-"));
  harness = await startHarness(tmpDir);
});

afterAll(async () => {
  await harness.dispose();
  rmSync(tmpDir, { recursive: true, force: true });
  await fake.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (!code || !state)
    throw new Error(`redirect missing code/state: ${location}`);
  return { code, state };
};

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("local mcp oauth (real OAuth + MCP server)", () => {
  it("startOAuth → authorize → completeOAuth writes tokens at the scope", async () => {
    const clientLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, harness.fetch)),
    );

    const namespace = `ns_${randomBytes(4).toString("hex")}`;
    const accessTokenSecretId = `mcp_${namespace}_access_token`;
    const refreshTokenSecretId = `mcp_${namespace}_refresh_token`;
    const redirectUrl = "http://local.test/api/mcp/oauth/callback";
    const scopeId = ScopeId.make(harness.scopeId);

    const run = <A, E>(
      body: (client: TestApiShape) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(TestApi, {
          baseUrl: TEST_BASE_URL,
        });
        return yield* body(client);
      }).pipe(Effect.provide(clientLayer)) as Effect.Effect<A, E>;

    const started = await Effect.runPromise(
      run((client) =>
        client.mcp.startOAuth({
          path: { scopeId },
          payload: {
            endpoint: `${fake.url}/mcp`,
            redirectUrl,
            accessTokenSecretId,
            refreshTokenSecretId,
          },
        }),
      ),
    );
    expect(started.sessionId).toMatch(/^mcp_oauth_/);

    const { code, state } = await followAuthorize(started.authorizationUrl);
    expect(state).toBe(started.sessionId);

    const completed = await Effect.runPromise(
      run((client) =>
        client.mcp.completeOAuth({
          path: { scopeId },
          payload: { state, code },
        }),
      ),
    );
    expect(completed.accessTokenSecretId).toBe(accessTokenSecretId);
    expect(completed.refreshTokenSecretId).toBe(refreshTokenSecretId);
    expect(completed.tokenType).toBe("Bearer");
    expect(completed.clientInformation).not.toBeNull();
    expect(completed.authorizationServerUrl).not.toBeNull();

    // Tokens landed at the (single) local scope and resolve back through
    // the same provider that the plugin wrote them to.
    const access = await Effect.runPromise(
      run((client) =>
        client.secrets.resolve({
          path: { scopeId, secretId: SecretId.make(accessTokenSecretId) },
        }),
      ),
    );
    expect(access.value).toMatch(/^at_/);

    const refresh = await Effect.runPromise(
      run((client) =>
        client.secrets.resolve({
          path: { scopeId, secretId: SecretId.make(refreshTokenSecretId) },
        }),
      ),
    );
    expect(refresh.value).toMatch(/^rt_/);
  }, 30_000);
});

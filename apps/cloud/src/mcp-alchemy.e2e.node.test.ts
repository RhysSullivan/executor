import { expect, it } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as TestCore from "alchemy/Test/Core";
import { installLocalhostDns } from "alchemy/Util/LocalhostDns";
import { Effect } from "effect";

import { makeTestBearer } from "./test-bearer";
import McpAlchemyTestWorker from "./test-worker-resource";

const testOptions = {
  providers: Cloudflare.providers(),
  dev: true,
} satisfies TestCore.MakeOptions;

installLocalhostDns();

const BASE = "https://test-resource.example.com";
const JSON_AND_SSE = "application/json, text/event-stream";

const nextOrgId = (() => {
  let seq = 0;
  return () => `org_mcp_alchemy_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
})();

const nextAccountId = (() => {
  let seq = 0;
  return () => `user_mcp_alchemy_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
})();

const initializeRequest = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-alchemy-e2e", version: "0.0.1" },
  },
};

const toolsListRequest = {
  jsonrpc: "2.0" as const,
  id: 2,
  method: "tools/list",
  params: {},
};

const initializedNotification = {
  jsonrpc: "2.0" as const,
  method: "notifications/initialized",
};

const mcpUrl = (baseUrl: string) => new URL("/mcp", baseUrl);

const mcpPost = (
  baseUrl: string,
  init: {
    readonly bearer?: string;
    readonly sessionId?: string | null;
    readonly body: unknown;
  },
) => {
  const headers: Record<string, string> = {
    accept: JSON_AND_SSE,
    "content-type": "application/json",
  };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.sessionId) headers["mcp-session-id"] = init.sessionId;
  return fetch(mcpUrl(baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(init.body),
  });
};

const seedOrg = (baseUrl: string, id: string, name = "MCP Alchemy Org") =>
  fetch(new URL("/__test__/seed-org", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name }),
  });

const newSessionId = (baseUrl: string) =>
  fetch(new URL("/__test__/new-session-id", baseUrl)).then(
    (response) => response.json() as Promise<{ sessionId: string }>,
  );

const readJson = (response: Response) => response.json() as Promise<Record<string, unknown>>;

const withAlchemyProvider = (
  name: string,
  fn: (stack: TestCore.ScratchStack) => Effect.Effect<void, any, any>,
) => {
  const scratch = TestCore.scratchStack(testOptions, name);
  return TestCore.toEffect(TestCore.withProviders(fn(scratch), testOptions, scratch.name), {
    ...testOptions,
    state: scratch.state,
  });
};

const destroyScratch = (stack: TestCore.ScratchStack) =>
  stack.destroy().pipe(Effect.catchCause(() => Effect.void));

it.live(
  "covers MCP HTTP behavior through an Alchemy local Worker",
  () =>
    withAlchemyProvider("covers MCP HTTP behavior through an Alchemy local Worker", (stack) =>
      Effect.gen(function* () {
        yield* destroyScratch(stack);
        const worker = yield* Effect.acquireRelease(stack.deploy(McpAlchemyTestWorker), () =>
          destroyScratch(stack),
        );

        const baseUrl = worker.url;
        expect(baseUrl).toEqual(expect.any(String));

        const preflight = yield* Effect.promise(() =>
          fetch(mcpUrl(baseUrl!), {
            method: "OPTIONS",
            headers: {
              origin: "https://claude.ai",
              "access-control-request-method": "POST",
              "access-control-request-headers": "authorization, content-type, mcp-session-id",
            },
          }),
        );
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
        expect(preflight.headers.get("access-control-allow-methods")).toBe(
          "GET, POST, DELETE, OPTIONS",
        );
        expect(preflight.headers.get("access-control-allow-headers") ?? "").toContain(
          "mcp-session-id",
        );

        const metadata = yield* Effect.promise(() =>
          fetch(new URL("/.well-known/oauth-protected-resource/mcp", baseUrl)),
        );
        expect(metadata.status).toBe(200);
        expect(yield* Effect.promise(() => readJson(metadata))).toEqual({
          resource: `${BASE}/mcp`,
          authorization_servers: ["https://test-authkit.example.com"],
          bearer_methods_supported: ["header"],
          scopes_supported: [],
        });

        const unauthorized = yield* Effect.promise(() =>
          mcpPost(baseUrl!, { body: initializeRequest }),
        );
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers.get("www-authenticate") ?? "").toContain(
          `${BASE}/.well-known/oauth-protected-resource/mcp`,
        );
        expect(yield* Effect.promise(() => readJson(unauthorized))).toEqual({
          error: "unauthorized",
        });

        const noOrg = yield* Effect.promise(() =>
          mcpPost(baseUrl!, {
            bearer: makeTestBearer(nextAccountId(), null),
            body: initializeRequest,
          }),
        );
        expect(noOrg.status).toBe(403);
        expect(yield* Effect.promise(() => readJson(noOrg))).toMatchObject({
          jsonrpc: "2.0",
          error: { code: -32001 },
        });

        const transientAuth = yield* Effect.promise(() =>
          mcpPost(baseUrl!, {
            bearer: "test-system-error",
            body: toolsListRequest,
          }),
        );
        expect(transientAuth.status).toBe(503);
        expect(yield* Effect.promise(() => readJson(transientAuth))).toMatchObject({
          jsonrpc: "2.0",
          error: { code: -32001 },
        });

        const { sessionId: staleSessionId } = yield* Effect.promise(() => newSessionId(baseUrl!));
        const stale = yield* Effect.promise(() =>
          mcpPost(baseUrl!, {
            bearer: makeTestBearer(nextAccountId(), nextOrgId()),
            sessionId: staleSessionId,
            body: toolsListRequest,
          }),
        );
        expect(stale.status).toBe(404);
        expect(yield* Effect.promise(() => readJson(stale))).toMatchObject({
          jsonrpc: "2.0",
          error: { code: -32001 },
        });

        const orgId = nextOrgId();
        const accountId = nextAccountId();
        const seeded = yield* Effect.promise(() => seedOrg(baseUrl!, orgId));
        expect(seeded.status).toBe(204);

        const initialized = yield* Effect.promise(() =>
          mcpPost(baseUrl!, {
            bearer: makeTestBearer(accountId, orgId),
            body: initializeRequest,
          }),
        );
        expect(initialized.status).toBe(200);
        const sessionId = initialized.headers.get("mcp-session-id");
        expect(sessionId).toEqual(expect.any(String));
        yield* Effect.promise(() => initialized.text());

        const notification = yield* Effect.promise(() =>
          mcpPost(baseUrl!, {
            bearer: makeTestBearer(accountId, orgId),
            sessionId,
            body: initializedNotification,
          }),
        );
        expect(notification.status).toBe(202);
        expect(notification.headers.get("content-type")).toBeNull();
        expect(yield* Effect.promise(() => notification.text())).toBe("");

        const attacker = yield* Effect.promise(() =>
          mcpPost(baseUrl!, {
            bearer: makeTestBearer(nextAccountId(), nextOrgId()),
            sessionId,
            body: toolsListRequest,
          }),
        );
        expect(attacker.status).toBe(403);
        expect(yield* Effect.promise(() => readJson(attacker))).toMatchObject({
          jsonrpc: "2.0",
          error: { code: -32003 },
        });
      }),
    ),
  180_000,
);

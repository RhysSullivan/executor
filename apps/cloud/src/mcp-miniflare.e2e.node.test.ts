// ---------------------------------------------------------------------------
// Real-port Miniflare e2e for the cloud MCP server.
// ---------------------------------------------------------------------------
//
// wrangler's `unstable_dev` boots the test-worker.ts entry on a real local
// port via Miniflare. The MCP SDK `Client` + `StreamableHTTPClientTransport`
// then drive `/mcp` exactly like a production client would — no hand-rolled
// JSON-RPC, no workerd-pool cross-request I/O workaround.
//
// `mcp-flow.test.ts` (workerd pool) rebuilds the DO runtime per request
// because workerd-pool's strict cross-request I/O check rejects a long-lived
// postgres socket; Miniflare on a real port has no such check, so this
// suite exercises the actual long-lived-socket DO runtime.
//
// Elicitation coverage uses the openapi plugin: a tiny Effect HttpApi
// upstream is stood up in-process, its generated spec is handed to
// `tools.openapi.addSource`, and the cloud engine invokes a POST operation.
// `requiresApproval: true` fires the executor's approval elicitation, which
// round-trips back to the SDK Client's `ElicitRequestSchema` handler.
// ---------------------------------------------------------------------------

import { expect, layer } from "@effect/vitest";
import { resolve } from "node:path";
import { createServer } from "node:http";

import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpServer,
  OpenApi,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Layer, Schema } from "effect";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

import { makeTestBearer } from "./test-bearer";

// ---------------------------------------------------------------------------
// Upstream test API — declared once via Effect's `HttpApi` so the spec the
// cloud engine consumes is derived from the same types the handlers use.
// ---------------------------------------------------------------------------

class ApprovedResponse extends Schema.Class<ApprovedResponse>("ApprovedResponse")({
  approved: Schema.Boolean,
}) {}

const ApproveGroup = HttpApiGroup.make("approve").add(
  HttpApiEndpoint.post("approveThing", "/approve").addSuccess(ApprovedResponse),
);

const UpstreamApi = HttpApi.make("approveApi").add(ApproveGroup);

const ApproveHandlers = HttpApiBuilder.group(UpstreamApi, "approve", (h) =>
  h.handle("approveThing", () =>
    Effect.succeed(new ApprovedResponse({ approved: true })),
  ),
);

const UpstreamApiLive = HttpApiBuilder.api(UpstreamApi).pipe(
  Layer.provide(ApproveHandlers),
);

const UpstreamServeLayer = HttpApiBuilder.serve().pipe(
  Layer.provide(UpstreamApiLive),
  Layer.provideMerge(
    NodeHttpServer.layer(() => createServer(), { port: 0, host: "127.0.0.1" }),
  ),
);

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

class Upstream extends Context.Tag("MiniflareE2E/Upstream")<
  Upstream,
  { readonly specJson: string; readonly url: string }
>() {}

class Worker extends Context.Tag("MiniflareE2E/Worker")<
  Worker,
  {
    readonly baseUrl: URL;
    readonly seedOrg: (id: string, name: string) => Promise<void>;
  }
>() {}

const UpstreamLive = Layer.effect(
  Upstream,
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const addr = server.address;
    if (addr._tag !== "TcpAddress") {
      return yield* Effect.die(`upstream server bound to non-TCP: ${addr._tag}`);
    }
    const url = `http://127.0.0.1:${addr.port}`;
    const specJson = JSON.stringify({
      ...OpenApi.fromApi(UpstreamApi),
      servers: [{ url }],
    });
    return { specJson, url };
  }),
).pipe(Layer.provide(UpstreamServeLayer));

const WorkerLive = Layer.scoped(
  Worker,
  Effect.acquireRelease(
    Effect.promise(() =>
      unstable_dev(resolve(__dirname, "./test-worker.ts"), {
        config: resolve(__dirname, "../wrangler.miniflare.jsonc"),
        experimental: { disableExperimentalWarning: true },
        ip: "127.0.0.1",
        logLevel: "info",
      }),
    ),
    (w) => Effect.promise(() => w.stop()),
  ).pipe(
    Effect.map((w: Unstable_DevWorker) => ({
      baseUrl: new URL(`http://${w.address}:${w.port}`),
      seedOrg: async (id: string, name: string) => {
        const res = await w.fetch("/__test__/seed-org", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, name }),
        });
        if (res.status !== 204) {
          throw new Error(`seed-org failed: ${res.status} ${await res.text()}`);
        }
      },
    })),
  ),
);

const TestEnv = Layer.mergeAll(UpstreamLive, WorkerLive);

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

let accountCounter = 0;
let orgCounter = 0;
const nextAccountId = () => `acct_miniflare_${++accountCounter}`;
const nextOrgId = () => `org_miniflare_${++orgCounter}`;

const connectClient = async (
  baseUrl: URL,
  bearer: string,
  options: { withElicitation?: boolean } = {},
): Promise<Client> => {
  const client = new Client(
    { name: "mcp-miniflare-e2e", version: "0.0.1" },
    {
      capabilities: options.withElicitation ? { elicitation: { form: {} } } : {},
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return client;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestEnv, { timeout: 60_000 })("cloud MCP over real HTTP (miniflare)", (it) => {
  it.effect("completes the initialize handshake via SDK", () =>
    Effect.gen(function* () {
      const { baseUrl, seedOrg } = yield* Worker;
      const orgId = nextOrgId();
      yield* Effect.promise(() => seedOrg(orgId, "Miniflare Org"));
      const client = yield* Effect.promise(() =>
        connectClient(baseUrl, makeTestBearer(nextAccountId(), orgId)),
      );
      expect(client.getServerVersion()?.name).toBe("executor");
      yield* Effect.promise(() => client.close());
    }), 30_000,
  );

  it.effect("lists the execute tool after handshake", () =>
    Effect.gen(function* () {
      const { baseUrl, seedOrg } = yield* Worker;
      const orgId = nextOrgId();
      yield* Effect.promise(() => seedOrg(orgId, "List Tools Org"));
      const client = yield* Effect.promise(() =>
        connectClient(baseUrl, makeTestBearer(nextAccountId(), orgId)),
      );
      const { tools } = yield* Effect.promise(() => client.listTools());
      expect(tools.map((t) => t.name)).toContain("execute");
      yield* Effect.promise(() => client.close());
    }), 30_000,
  );

  it.effect("executes code end-to-end via tools/call", () =>
    Effect.gen(function* () {
      const { baseUrl, seedOrg } = yield* Worker;
      const orgId = nextOrgId();
      yield* Effect.promise(() => seedOrg(orgId, "Execute Org"));
      const client = yield* Effect.promise(() =>
        connectClient(baseUrl, makeTestBearer(nextAccountId(), orgId)),
      );
      const result = yield* Effect.promise(() =>
        client.callTool({ name: "execute", arguments: { code: "return 1 + 2" } }),
      );
      expect(result.isError).not.toBe(true);
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      expect(content.find((c) => c.type === "text")?.text ?? "").toContain("3");
      yield* Effect.promise(() => client.close());
    }), 30_000,
  );

  it.effect("round-trips approval elicitation for a POST openapi operation", () =>
    Effect.gen(function* () {
      const { baseUrl, seedOrg } = yield* Worker;
      const { specJson } = yield* Upstream;
      const orgId = nextOrgId();
      yield* Effect.promise(() => seedOrg(orgId, "Elicit Org"));

      const client = yield* Effect.promise(() =>
        connectClient(baseUrl, makeTestBearer(nextAccountId(), orgId), {
          withElicitation: true,
        }),
      );

      let elicitCount = 0;
      client.setRequestHandler(ElicitRequestSchema, async () => {
        elicitCount++;
        return { action: "accept" as const, content: {} };
      });

      // User code inside `execute` (1) registers the upstream as an OpenAPI
      // source and (2) invokes its POST operation. `annotationsForOperation`
      // marks the POST as `requiresApproval: true`, which fires
      // `enforceApproval` in the executor; that goes through the MCP
      // elicitation handler and lands on `client.setRequestHandler` above.
      // Tool id is `<namespace>.<group>.<operation>` — Effect's
      // `HttpApiGroup` name ("approve") becomes part of the sandbox path,
      // so the invocation reads `tools.approveapi.approve.approveThing`.
      const code = [
        `await tools.openapi.addSource({ spec: ${JSON.stringify(specJson)}, namespace: "approveapi" });`,
        `return await tools.approveapi.approve.approveThing({});`,
      ].join("\n");
      const result = yield* Effect.promise(() =>
        client.callTool({ name: "execute", arguments: { code } }),
      );
      expect(result.isError).not.toBe(true);
      expect(elicitCount).toBeGreaterThan(0);
      const text = ((result.content ?? []) as Array<{ type: string; text?: string }>)
        .find((c) => c.type === "text")?.text ?? "";
      expect(text).toContain("approved");

      yield* Effect.promise(() => client.close());
    }), 30_000,
  );
});

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
import type { AddressInfo } from "node:net";

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

type CapturedSpan = {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly attributes: Record<string, unknown>;
};

class TelemetryReceiver extends Context.Tag("MiniflareE2E/TelemetryReceiver")<
  TelemetryReceiver,
  {
    readonly tracesUrl: string;
    readonly spans: () => ReadonlyArray<CapturedSpan>;
    readonly waitForSpan: (
      predicate: (span: CapturedSpan) => boolean,
      timeoutMs?: number,
    ) => Promise<CapturedSpan>;
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

// ---------------------------------------------------------------------------
// Telemetry receiver — a node HTTP server on a random port that speaks
// OTLP/JSON. The Effect OTLPTraceExporter in `services/telemetry.ts`
// posts JSON bodies to it (confirmed via
// `@opentelemetry/exporter-trace-otlp-http` — `Content-Type:
// application/json` + `JsonTraceSerializer`). We parse resourceSpans →
// scopeSpans → spans → attributes so tests can assert the DO actually
// reported the expected spans, not just that the exporter was called.
// ---------------------------------------------------------------------------

type OtlpAttributeValue = {
  readonly stringValue?: string;
  readonly intValue?: string | number;
  readonly doubleValue?: number;
  readonly boolValue?: boolean;
};
type OtlpAttribute = { readonly key: string; readonly value?: OtlpAttributeValue };
type OtlpSpan = {
  readonly name: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly attributes?: ReadonlyArray<OtlpAttribute>;
};
type OtlpPayload = {
  readonly resourceSpans?: ReadonlyArray<{
    readonly scopeSpans?: ReadonlyArray<{ readonly spans?: ReadonlyArray<OtlpSpan> }>;
  }>;
};

const unwrapAttrValue = (v?: OtlpAttributeValue): unknown => {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
};

const TelemetryReceiverLive = Layer.scoped(
  TelemetryReceiver,
  Effect.acquireRelease(
    Effect.async<
      {
        readonly tracesUrl: string;
        readonly spans: ReadonlyArray<CapturedSpan>;
        readonly store: Array<CapturedSpan>;
        readonly close: () => Promise<void>;
      },
      never
    >((resume) => {
      const store: Array<CapturedSpan> = [];
      const server = createServer((req, res) => {
        if (req.method !== "POST" || !req.url?.endsWith("/v1/traces")) {
          res.statusCode = 404;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body) as OtlpPayload;
            for (const rs of payload.resourceSpans ?? []) {
              for (const ss of rs.scopeSpans ?? []) {
                for (const sp of ss.spans ?? []) {
                  const attrs: Record<string, unknown> = {};
                  for (const a of sp.attributes ?? []) {
                    attrs[a.key] = unwrapAttrValue(a.value);
                  }
                  store.push({
                    name: sp.name,
                    traceId: sp.traceId ?? "",
                    spanId: sp.spanId ?? "",
                    parentSpanId: sp.parentSpanId ? sp.parentSpanId : null,
                    attributes: attrs,
                  });
                }
              }
            }
          } catch {
            // ignore malformed payloads
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        resume(
          Effect.succeed({
            tracesUrl: `http://127.0.0.1:${addr.port}/v1/traces`,
            spans: store,
            store,
            close: () => new Promise<void>((r) => server.close(() => r())),
          }),
        );
      });
    }),
    (t) => Effect.promise(() => t.close()),
  ).pipe(
    Effect.map((t) => ({
      tracesUrl: t.tracesUrl,
      spans: () => [...t.store],
      waitForSpan: async (
        predicate: (s: CapturedSpan) => boolean,
        timeoutMs = 5_000,
      ) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const hit = t.store.find(predicate);
          if (hit) return hit;
          if (Date.now() > deadline) {
            throw new Error(
              `Timed out waiting for span. Captured ${t.store.length}: ${t.store.map((s) => s.name).join(", ") || "<none>"}`,
            );
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    })),
  ),
);

const WorkerLive = Layer.scoped(
  Worker,
  Effect.gen(function* () {
    const receiver = yield* TelemetryReceiver;
    // AXIOM_TOKEN activates DoTelemetryLive inside the worker; AXIOM_TRACES_URL
    // redirects the exporter at our in-process OTLP/JSON receiver so spans
    // become observable in the test process.
    return yield* Effect.acquireRelease(
      Effect.promise(() =>
        unstable_dev(resolve(__dirname, "./test-worker.ts"), {
          config: resolve(__dirname, "../wrangler.miniflare.jsonc"),
          experimental: { disableExperimentalWarning: true },
          ip: "127.0.0.1",
          logLevel: "info",
          vars: {
            AXIOM_TOKEN: "test-token",
            AXIOM_TRACES_URL: receiver.tracesUrl,
          },
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
    );
  }),
);

const TestEnv = Layer.mergeAll(UpstreamLive, WorkerLive).pipe(
  Layer.provideMerge(TelemetryReceiverLive),
);

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
  it.effect("returns 401 for malformed bearer tokens through the production auth layer", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* Worker;
      const response = yield* Effect.promise(() =>
        fetch(new URL("/__test__/real-auth-mcp", baseUrl), {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            authorization: "Bearer bogus",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "mcp-miniflare-invalid-bearer", version: "0" },
            },
          }),
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate") ?? "").toContain(
        "https://test-resource.example.com/.well-known/oauth-protected-resource/mcp",
      );
      const body = yield* Effect.promise(() => response.json());
      expect(body).toEqual({ error: "unauthorized" });
    }), 30_000,
  );

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

  it.effect("reports the McpSessionDO.handleRequest span via the OTLP exporter", () =>
    Effect.gen(function* () {
      const { baseUrl, seedOrg } = yield* Worker;
      const receiver = yield* TelemetryReceiver;
      const orgId = nextOrgId();
      yield* Effect.promise(() => seedOrg(orgId, "Telemetry Org"));
      const client = yield* Effect.promise(() =>
        connectClient(baseUrl, makeTestBearer(nextAccountId(), orgId)),
      );
      // Trigger the DO through a multi-step flow so we can assert that
      // handleRequest spans are reported for every DO hit, not just init.
      yield* Effect.promise(() => client.listTools());
      yield* Effect.promise(() =>
        client.callTool({ name: "execute", arguments: { code: "return 1 + 2" } }),
      );
      yield* Effect.promise(() => client.close());

      // The initialize POST carries no session-id; subsequent requests do.
      // Assert on one of the session-id'd handleRequest spans so we verify
      // attribute propagation beyond the degenerate init case.
      const handleSpan = yield* Effect.promise(() =>
        receiver.waitForSpan(
          (s) =>
            s.name === "McpSessionDO.handleRequest" &&
            s.attributes["mcp.request.session_id_present"] === true,
        ),
      );
      expect(handleSpan.attributes["mcp.request.method"]).toBeDefined();
      // 200 for normal POSTs, 202 for notifications/initialized.
      expect([200, 202]).toContain(handleSpan.attributes["mcp.response.status_code"]);
      expect(handleSpan.attributes["mcp.response.content_type"]).toEqual(expect.any(String));
      expect(handleSpan.attributes["mcp.transport.enable_json_response"]).toBe(true);

      // init runs once per new session and should appear on the initialize POST.
      yield* Effect.promise(() =>
        receiver.waitForSpan((s) => s.name === "McpSessionDO.init"),
      );
    }), 30_000,
  );

});

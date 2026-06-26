// Non-code connection mode (`?codemode=false`). By default an Executor MCP
// session runs in "code mode": one `execute` tool the model writes TypeScript
// against, discovering connections through `tools.search()` /
// `tools.describe.tool()` and calling them as `tools.<...>()` inside the
// sandbox. Some clients can't drive a code sandbox and instead want to discover
// and call tools through plain MCP tool calls, so the session accepts
// `?codemode=false` and exposes two meta-tools, `search` and `invoke`, instead
// of `execute`.
//
// Why not just dump every tool directly (the obvious reading of the Cloudflare
// `?codemode=false` switch)? Because a real catalog is enormous: the full
// Microsoft Graph connection alone is ~16.5k tools / hundreds of MB of inlined
// schema, which no client can load in one `tools/list`. `search`+`invoke` is the
// lazy-loading shape: the client searches for the handful of tools it needs and
// invokes them by name, so it scales to any catalog. (See mcp-codemode-scale.)
//
// The seam under test: the SAME connected identity, opened with the query param,
// advertises `search`/`invoke` instead of `execute`; `search` finds a seeded
// connection's tools, and `invoke` runs one and returns its real result. A
// default (code-mode) session of the same identity is the contrast: it still
// advertises only `execute`.
import { randomBytes, randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

// A built-in core tool present on every target. In non-code mode it is invoked
// by this wire name through the `invoke` meta-tool (a static core tool's address
// has no `tools.` prefix, so it survives `addressToPath` unchanged), and it
// returns real data (the policy listing) we can verify.
const CORE_TOOL = "executor.coreTools.policies.list";

// The approval-gated core tool used by the pause+resume scenario below. It gates
// on its own `requiresApproval` annotation (no policy needed), so invoking it
// pauses, and resuming exercises the non-code resume formatter.
const POLICY_CREATE_TOOL = "executor.coreTools.policies.create";

// Minimal three-operation spec: three operations become three connection tools.
// The baseUrl is never contacted; we only need the tools to exist in the
// catalog so `search` has something to find.
const ordersOpenApiSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Orders API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/orders/{orderId}": {
        get: {
          operationId: "getOrder",
          summary: "Fetch a single order",
          parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "An order." } },
        },
      },
      "/orders": {
        get: {
          operationId: "listOrders",
          summary: "List orders",
          responses: { "200": { description: "The orders." } },
        },
        post: {
          operationId: "createOrder",
          summary: "Create an order",
          responses: { "201": { description: "The created order." } },
        },
      },
    },
  });

// `search`/`invoke` use the same `addressToPath(address)` the engine does: a
// leading proxy-root `tools.` is stripped, everything else is left as-is.
// Deriving the expected name from the same catalog keeps the assertion from
// drifting if the address format changes.
const wireName = (address: string): string =>
  address.startsWith("tools.") ? address.slice("tools.".length) : address;

const apiKeyTemplate = [
  {
    slug: "apiKey",
    type: "apiKey",
    headers: { "x-api-key": [{ type: "variable", name: "token" }] },
  },
] as const;

type SearchPage = {
  readonly items?: ReadonlyArray<{ readonly name?: string; readonly inputSchema?: unknown }>;
  readonly total?: number;
};

const searchPageOf = (raw: unknown): SearchPage =>
  ((raw as { structuredContent?: SearchPage }).structuredContent ?? {}) as SearchPage;

scenario(
  "MCP · ?codemode=false exposes search + invoke instead of `execute`",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const apiClient = yield* client(api, identity);

    // Unique slug per run keeps parallel/repeated runs out of each other's
    // catalog (selfhost shares the bootstrap-admin identity).
    const nonce = randomBytes(4).toString("hex");
    const slug = `codemode-orders-${nonce}`;
    const specBaseUrl = "http://127.0.0.1:59999"; // never contacted

    const cleanup = Effect.gen(function* () {
      yield* apiClient.connections
        .remove({
          params: {
            owner: "org",
            integration: IntegrationSlug.make(slug),
            name: ConnectionName.make("main"),
          },
        })
        .pipe(Effect.ignore);
      yield* apiClient.integrations
        .remove({ params: { slug: IntegrationSlug.make(slug) } })
        .pipe(Effect.ignore);
    });

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Seed an integration + connection so `search` has tools to find.
        const added = yield* apiClient.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: ordersOpenApiSpec(specBaseUrl) },
            slug,
            baseUrl: specBaseUrl,
            authenticationTemplate: apiKeyTemplate,
          },
        });
        expect(added.toolCount, "the orders fixture's operations became tools").toBe(3);

        const providers = yield* apiClient.providers.list();
        yield* apiClient.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("apiKey"),
            from: { provider: providers[0]!, id: ProviderItemId.make(randomUUID()) },
          },
        });

        // The exact wire names `search` should surface, derived from the catalog.
        const catalog = yield* apiClient.tools.list({
          query: { integration: IntegrationSlug.make(slug) },
        });
        const expectedConnectionTools = catalog.map((tool) => wireName(String(tool.address)));
        expect(
          expectedConnectionTools.length,
          "the three connection tools are in the catalog",
        ).toBe(3);

        // A policy with an unrelated pattern: it does NOT gate `policies.list`,
        // so the invoke below runs ungated. Its id only has to appear in the
        // listing to prove the tool actually executed and returned data.
        const policy = yield* apiClient.policies.create({
          payload: { owner: "org", pattern: `codemode.gate.${nonce}`, action: "block" },
        });

        yield* Effect.ensuring(
          Effect.gen(function* () {
            const noncode = mcp.session(identity, { codeMode: false });

            // 1) The advertised tools are the meta-tools, NOT `execute` and NOT a
            //    dumped catalog.
            const tools = yield* noncode.listTools();
            expect(tools, "search is advertised").toContain("search");
            expect(tools, "invoke is advertised").toContain("invoke");
            expect(tools, "code mode's `execute` is gone").not.toContain("execute");
            expect(
              tools,
              "the catalog is NOT dumped directly (that is the whole point)",
            ).not.toContain(expectedConnectionTools[0]!);

            // 2) `search` finds the seeded connection's tools, each with a schema.
            const search = yield* noncode.call("search", { query: slug });
            expect(search.ok, "search completed without error").toBe(true);
            const page = searchPageOf(search.raw);
            const found = (page.items ?? []).map((item) => item.name);
            for (const name of expectedConnectionTools) {
              expect(found, `search surfaced connection tool ${name}`).toContain(name);
            }
            expect(
              (page.items ?? []).every((item) => item.inputSchema != null),
              "each search hit carries its input schema, so it can be invoked directly",
            ).toBe(true);

            // 3) `invoke` runs a tool by name and returns its real result.
            const invoked = yield* noncode.call("invoke", { name: CORE_TOOL, arguments: {} });
            expect(invoked.ok, "the invoke completed without error").toBe(true);
            expect(
              invoked.text,
              "the listing the tool returned includes the policy we created",
            ).toContain(policy.id);

            // 4) Contrast: the same identity in default (code) mode still gets the
            //    single `execute` tool and not the meta-tools.
            const codeModeSession = mcp.session(identity);
            const codeModeTools = yield* codeModeSession.listTools();
            expect(codeModeTools, "code mode still advertises `execute`").toContain("execute");
            expect(codeModeTools, "code mode does not advertise `search`").not.toContain("search");
          }),
          apiClient.policies
            .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
            .pipe(Effect.ignore),
        );
      }),
      cleanup,
    );
  }),
);

// Result-shape parity across the pause boundary. An `invoke`d tool that pauses
// for approval and then resumes must return the SAME shape it would have
// returned without pausing: the tool's own result, unwrapped from the
// `ToolResult` envelope. The `resume` machinery is shared with code mode, where a
// completion is an `execute` envelope (`{ status, result, logs }`); a regression
// here formatted the resumed direct-tool result that same way, so a non-code
// client got the code-mode envelope instead of the tool's fields. This drives
// the approval-gated `policies.create` through invoke -> pause -> approve ->
// resume and asserts the resumed structured content is the policy itself.
scenario(
  "MCP · ?codemode=false keeps the unwrapped tool result across an approval pause+resume",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const apiClient = yield* client(api, identity);

    // Unique, non-matching pattern: the rule the gated tool creates is inert and
    // cannot gate any other scenario's tools. Removed in the finalizer.
    const nonce = randomBytes(4).toString("hex");
    const pattern = `codemode-resume-${nonce}.gate`;

    const cleanup = apiClient.policies.list().pipe(
      Effect.flatMap((list) =>
        Effect.forEach(
          list.filter((p) => p.pattern === pattern),
          (p) =>
            apiClient.policies
              .remove({ params: { policyId: p.id }, payload: { owner: "org" } })
              .pipe(Effect.ignore),
        ),
      ),
      Effect.ignore,
    );

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const noncode = mcp.session(identity, { codeMode: false });
        yield* noncode.listTools();

        // Invoke the approval-gated tool by name. No policy is in play, so the
        // only thing that can pause it is its own `requiresApproval` annotation.
        // The paused result carries the executionId to resume.
        const paused = yield* noncode.call("invoke", {
          name: POLICY_CREATE_TOOL,
          arguments: { owner: "org", pattern, action: "block" },
        });
        expect(paused.text, "the gated tool paused for approval").toContain("Execution paused");
        expect(paused.text, "the paused result carries an executionId").toContain("executionId:");

        // Approve and resume.
        const resumed = yield* noncode.approvePaused(paused.text);
        expect(resumed.ok, "the resumed call completed without error").toBe(true);

        const structured = (resumed.raw as { structuredContent?: Record<string, unknown> })
          .structuredContent;
        // Fixed shape: the tool's own result, so the policy fields sit at the top
        // level. Buggy shape: the code-mode `execute` envelope, where the policy
        // would be nested under `result` and `pattern` absent at the top level.
        expect(
          structured?.pattern,
          "the resumed result is the unwrapped tool result (policy fields at the top level)",
        ).toBe(pattern);
        expect(
          structured?.result,
          "the code-mode execute envelope (status/result/logs) is not used in non-code mode",
        ).toBeUndefined();
      }),
      cleanup,
    );
  }),
);

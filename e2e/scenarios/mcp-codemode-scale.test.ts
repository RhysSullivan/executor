// Non-code mode (`?codemode=false`) at real catalog scale. This is the scenario
// that justified the design: dumping every tool directly does not scale (the
// full Microsoft Graph catalog is ~16.5k tools / hundreds of MB of inlined
// schema, far too big for any client to load in one `tools/list`). `search` +
// `invoke` is the lazy-loading answer: a fixed two-tool surface that never
// returns more than a bounded page, no matter how large the catalog is.
//
// What it asserts, against the full Graph catalog and the suite's trace store:
//   - the non-code session advertises only the meta-tools, NOT the 16.5k-tool
//     catalog (the dump is gone);
//   - `search` over the whole catalog returns a small bounded page, each hit
//     carrying its own schema;
//   - each invocation dispatches the tool exactly once (`executor.tool.execute`),
//     with no fan-out;
//   - a single invocation's trace neither searches nor rebuilds the catalog
//     (no `executor.tools.search`, no `executor.tools.sync_stale`) — resolving
//     one tool out of 16.5k is O(1), it does not touch the rest of the catalog;
//   - the catalog is served from persisted bindings, not re-parsed on every read
//     (`executor.tools.sync_stale`, scoped to this run, fires at most once).
//
// Telemetry is only wired on targets that boot motel (cloud today), so this
// scenario yields `Telemetry` up front and skips cleanly elsewhere. It drives
// only public surfaces (typed API + MCP), so a green run is real evidence.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import {
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_ALL_PRESET_IDS,
} from "@executor-js/plugin-microsoft";
import { microsoftHttpPlugin } from "@executor-js/plugin-microsoft/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import type { ExportedSpan, SpanQuery, TelemetrySurface } from "../src/surfaces/telemetry";
import { Api, Mcp, Target, Telemetry } from "../src/services";

const api = composePluginApi([microsoftHttpPlugin()] as const);

const SEARCH_LIMIT = 5;
const HOW_MANY_INVOCATIONS = 3;

type SearchPage = {
  readonly items?: ReadonlyArray<{ readonly name?: string; readonly inputSchema?: unknown }>;
  readonly total?: number;
};

const searchPageOf = (raw: unknown): SearchPage =>
  ((raw as { structuredContent?: SearchPage }).structuredContent ?? {}) as SearchPage;

// Spans flush ~1s after the request (BatchSpanProcessor, drained on waitUntil).
// Poll the store until at least `n` matching spans have arrived, then hand the
// set back so the caller can assert the exact count. ~20s ceiling: slower is a
// real export bug, and the test should fail rather than hang.
const searchUntilCount = (
  telemetry: TelemetrySurface,
  query: SpanQuery,
  n: number,
): Effect.Effect<readonly ExportedSpan[], unknown> =>
  telemetry.searchSpans(query).pipe(
    Effect.filterOrFail(
      (spans) => spans.length >= n,
      (spans) => `expected >= ${n} spans for ${JSON.stringify(query)}, saw ${spans.length}`,
    ),
    Effect.retry(Schedule.both(Schedule.spaced("500 millis"), Schedule.recurs(40))),
  );

scenario(
  "MCP · ?codemode=false searches a 16k-tool catalog and invokes without dumping it",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const mcp = yield* Mcp;
    // Skips on any target without a trace store (selfhost, cloudflare today).
    const telemetry = yield* Telemetry;
    const identity = yield* target.newIdentity();
    const apiClient = yield* client(api, identity);

    const slug = `codemode-scale-${randomBytes(4).toString("hex")}`;
    const connection = ConnectionName.make("main");

    const cleanup = Effect.gen(function* () {
      yield* apiClient.connections
        .remove({
          params: { owner: "org", integration: IntegrationSlug.make(slug), name: connection },
        })
        .pipe(Effect.ignore);
      yield* apiClient.microsoft
        .removeGraph({ params: { slug: IntegrationSlug.make(slug) } })
        .pipe(Effect.ignore);
    });

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Seed the full Graph catalog: every workload, ~16.5k operations.
        const added = yield* apiClient.microsoft.addGraph({
          payload: {
            presetIds: [...MICROSOFT_GRAPH_ALL_PRESET_IDS],
            customScopes: [],
            slug,
            name: "Microsoft Graph (codemode scale)",
          },
        });
        expect(
          added.toolCount,
          "the full Graph catalog extracts thousands of tools",
        ).toBeGreaterThan(5_000);

        // A static token is enough to exercise resolve+invoke; the upstream 401
        // surfaces as a tool failure, which still emits the spans we assert on.
        yield* apiClient.connections.create({
          payload: {
            owner: "org",
            name: connection,
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
            value: "token-xyz",
          },
        });

        const noncode = mcp.session(identity, { codeMode: false });

        // 1) The non-code session advertises the meta-tools, NOT the 16.5k-tool
        //    catalog. This is the whole point: the catalog is never dumped.
        const tools = yield* noncode.listTools();
        expect(tools, "search is advertised").toContain("search");
        expect(tools, "invoke is advertised").toContain("invoke");
        expect(
          tools.length,
          "the giant catalog is not dumped — only the fixed meta-tools are advertised",
        ).toBeLessThan(5);

        // 2) `search` ranks over the whole catalog but returns a small bounded
        //    page, each hit with its own schema.
        const search = yield* noncode.call("search", { query: "user", limit: SEARCH_LIMIT });
        expect(search.ok, "search completed without error").toBe(true);
        const page = searchPageOf(search.raw);
        const hits = page.items ?? [];
        expect(hits.length, "search returns a bounded page, not the catalog").toBeLessThanOrEqual(
          SEARCH_LIMIT,
        );
        expect(hits.length, "search found matching tools").toBeGreaterThan(0);
        expect(
          hits.every((hit) => hit.inputSchema != null),
          "each hit carries its input schema",
        ).toBe(true);

        const targetTool = hits[0]!.name!;
        // The `executor.tool.execute` span stamps the full address, which is
        // `tools.<wire>` (the proxy-root prefix the wire name strips).
        const executeToolName = `tools.${targetTool}`;

        // 3) Invoke the found tool several times. Each hits Graph with the fake
        //    token (401 -> tool failure) but exercises the full resolve+invoke
        //    path and emits one execute span per call.
        for (let i = 0; i < HOW_MANY_INVOCATIONS; i++) {
          yield* noncode.call("invoke", { name: targetTool, arguments: {} });
        }

        // (a) Every invocation dispatched the tool exactly once: no fan-out.
        const executes = yield* searchUntilCount(
          telemetry,
          {
            operation: "executor.tool.execute",
            attributes: { "mcp.tool.name": executeToolName },
          },
          HOW_MANY_INVOCATIONS,
        );
        expect(executes.length, "each invocation dispatches the tool exactly once").toBe(
          HOW_MANY_INVOCATIONS,
        );

        // (b) A single invocation is O(1) in the catalog: its whole trace neither
        //     searches nor rebuilds the catalog. Resolving one tool out of 16.5k
        //     must not touch the rest.
        const invokeTrace = yield* telemetry.searchSpans({ traceId: executes[0]!.traceId });
        const operations = invokeTrace.map((entry) => entry.span.operationName);
        expect(operations, "an invocation does not search the whole catalog").not.toContain(
          "executor.tools.search",
        );
        expect(operations, "an invocation does not rebuild the catalog").not.toContain(
          "executor.tools.sync_stale",
        );

        // (c) The catalog is served from persisted bindings, not re-parsed on
        //     every read: the per-connection rebuild for THIS integration fires
        //     at most once across the search above.
        const rebuilds = yield* telemetry.searchSpans({
          operation: "executor.tools.sync_stale",
          attributes: { "executor.integration": slug },
        });
        expect(
          rebuilds.length,
          "the catalog is not rebuilt/re-parsed on every read",
        ).toBeLessThanOrEqual(1);
      }),
      cleanup,
    );
  }),
);

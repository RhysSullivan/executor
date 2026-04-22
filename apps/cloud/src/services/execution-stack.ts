// ---------------------------------------------------------------------------
// Shared execution stack — the wiring that turns an organization into a
// runnable executor + engine. Used by the protected HTTP API (per-request)
// and the MCP session DO (per-session) so changes to the stack flow to both.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { createExecutionEngine } from "@executor/execution";
import { makeDynamicWorkerExecutor } from "@executor/runtime-dynamic-worker";
import type { Tool, ToolListFilter } from "@executor/sdk";

import { withExecutionUsageTracking } from "../api/execution-usage";
import { AutumnService } from "./autumn";
import { createScopedExecutor } from "./executor";

// In-memory tools.list cache on the DO. `tools.search` scans the full
// list on every call, so caching it collapses the N calls in a session
// into one DB fetch. DO lifetime caps cache staleness at
// SESSION_TIMEOUT_MS (5m idle) — no TTL needed.
const makeToolsListCache = <E, R>(
  inner: (filter?: ToolListFilter) => Effect.Effect<readonly Tool[], E, R>,
) => {
  const cache = new Map<string, readonly Tool[]>();
  return (filter?: ToolListFilter) =>
    Effect.gen(function* () {
      const key = JSON.stringify(filter ?? null);
      const hit = cache.get(key);
      if (hit) {
        yield* Effect.annotateCurrentSpan({ "cache.state": "hit" });
        return hit;
      }
      const value = yield* inner(filter);
      cache.set(key, value);
      yield* Effect.annotateCurrentSpan({ "cache.state": "miss" });
      return value;
    }).pipe(Effect.withSpan("executor.tools.list.cached"));
};

export const makeExecutionStack = (
  userId: string,
  organizationId: string,
  organizationName: string,
) =>
  Effect.gen(function* () {
    const rawExecutor = yield* createScopedExecutor(
      userId,
      organizationId,
      organizationName,
    ).pipe(Effect.withSpan("McpSessionDO.createScopedExecutor"));
    const executor = {
      ...rawExecutor,
      tools: {
        ...rawExecutor.tools,
        list: makeToolsListCache(rawExecutor.tools.list),
      },
    };
    const codeExecutor = makeDynamicWorkerExecutor({ loader: env.LOADER });
    const autumn = yield* AutumnService;
    const engine = withExecutionUsageTracking(
      organizationId,
      createExecutionEngine({ executor, codeExecutor }),
      (orgId) => Effect.runFork(autumn.trackExecution(orgId)),
    );
    return { executor, engine };
  }).pipe(Effect.withSpan("McpSessionDO.makeExecutionStack"));

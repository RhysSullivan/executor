// ---------------------------------------------------------------------------
// Shared execution stack — the wiring that turns an organization into a
// runnable executor + engine. Used by the protected HTTP API (per-request)
// and the MCP session DO (per-session) so changes to the stack flow to both.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { createExecutionEngine } from "@executor-js/execution";
import { composeExecutionObservers } from "@executor-js/sdk";
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";

import { withExecutionUsageTracking } from "../api/execution-usage";
import { AutumnService } from "./autumn";
import { createScopedExecutorBundle } from "./executor";

export const makeExecutionStack = (
  userId: string,
  organizationId: string,
  organizationName: string,
) =>
  Effect.gen(function* () {
    const { executor, plugins } = yield* createScopedExecutorBundle(
      userId,
      organizationId,
      organizationName,
    ).pipe(Effect.withSpan("McpSessionDO.createScopedExecutor"));
    const codeExecutor = makeDynamicWorkerExecutor({ loader: env.LOADER });
    const observer = composeExecutionObservers(plugins, executor);
    const autumn = yield* AutumnService;
    const engine = withExecutionUsageTracking(
      organizationId,
      createExecutionEngine({ executor, codeExecutor, observer }),
      (orgId) => Effect.runFork(autumn.trackExecution(orgId)),
    );
    return { executor, engine };
  }).pipe(Effect.withSpan("McpSessionDO.makeExecutionStack"));

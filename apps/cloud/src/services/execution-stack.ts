// ---------------------------------------------------------------------------
// Shared execution stack — the wiring that turns an organization into a
// runnable executor + engine. Used by the protected HTTP API (per-request)
// and the MCP session DO (per-session) so changes to the stack flow to both.
// ---------------------------------------------------------------------------

import * as Cloudflare from "alchemy/Cloudflare/Workers/Runtime";
import { Effect } from "effect";

import { createExecutionEngine } from "@executor-js/execution";

import { withExecutionUsageTracking } from "../api/execution-usage";
import { AutumnService } from "./autumn";
import { createScopedExecutor } from "./executor";

export const makeExecutionStack = Effect.fn("McpSessionDO.makeExecutionStack")(function* (
  userId: string,
  organizationId: string,
  organizationName: string,
) {
  const executor = yield* createScopedExecutor(userId, organizationId, organizationName).pipe(
    Effect.withSpan("McpSessionDO.createScopedExecutor"),
  );
  const workerEnv = yield* Cloudflare.WorkerEnvironment.typed<Env>();
  const { makeDynamicWorkerExecutor } = yield* Effect.promise(
    () => import("@executor-js/runtime-dynamic-worker"),
  );
  const codeExecutor = makeDynamicWorkerExecutor({ loader: workerEnv.LOADER });
  const autumn = yield* AutumnService;
  const engine = withExecutionUsageTracking(
    organizationId,
    createExecutionEngine({ executor, codeExecutor }),
    autumn.trackExecution,
  );
  return { executor, engine };
});

// ---------------------------------------------------------------------------
// Shared execution stack — the wiring that turns an organization into a
// runnable executor + engine. Used by the protected HTTP API (per-request)
// and the MCP session DO (per-session) so changes to the stack flow to both.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { createExecutionEngine } from "@executor/execution";
import { makeDynamicWorkerExecutor } from "@executor/runtime-dynamic-worker";

import { withExecutionUsageTracking } from "../api/execution-usage";
import { AutumnService } from "./autumn";
import { makeTrackExecutionUsage } from "./autumn-tracker";
import { createScopedExecutor } from "./executor";

export const makeExecutionStack = (organizationId: string, organizationName: string) =>
  Effect.gen(function* () {
    const executor = yield* createScopedExecutor(organizationId, organizationName);
    const codeExecutor = makeDynamicWorkerExecutor({ loader: env.LOADER });
    const autumn = yield* AutumnService;
    const engine = withExecutionUsageTracking(
      organizationId,
      createExecutionEngine({ executor, codeExecutor }),
      makeTrackExecutionUsage(autumn),
    );
    return { executor, engine };
  });

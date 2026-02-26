import { createRpcFactory, makeRpcModule } from "@executor-v2/confect/rpc";
import { executorConfectSchema } from "@executor-v2/persistence-convex";
import type { ExecuteRunInput } from "@executor-v2/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  ConvexRunExecutor,
  ConvexRunExecutorLive,
  ConvexToolProviderRegistryLive,
} from "./run_executor";

const executeRunResultSchema = Schema.Struct({
  runId: Schema.String,
  status: Schema.Union(
    Schema.Literal("completed"),
    Schema.Literal("failed"),
    Schema.Literal("timed_out"),
    Schema.Literal("denied"),
  ),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
});

const factory = createRpcFactory({
  schema: executorConfectSchema,
});

const ConvexExecuteDependenciesLive = Layer.merge(
  ConvexRunExecutorLive,
  ConvexToolProviderRegistryLive,
);

export const executeRunImpl = (
  input: ExecuteRunInput,
): Effect.Effect<typeof executeRunResultSchema.Type> =>
  Effect.gen(function* () {
    const runExecutor = yield* ConvexRunExecutor;
    return yield* runExecutor.executeRun(input);
  }).pipe(Effect.provide(ConvexExecuteDependenciesLive));

const executeRunEndpoint = factory.action({
  payload: {
    code: Schema.String,
    timeoutMs: Schema.optional(Schema.Number),
  },
  success: executeRunResultSchema,
});

executeRunEndpoint.implement((payload) =>
  executeRunImpl({
    code: payload.code,
    timeoutMs: payload.timeoutMs,
  }),
);

const executorRpc = makeRpcModule({
  executeRun: executeRunEndpoint,
});

export const executeRun = executorRpc.handlers.executeRun;

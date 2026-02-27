import { ToolProviderRegistryService } from "@executor-v2/engine";
import { handleMcpHttpRequest } from "@executor-v2/mcp-gateway";
import { createExecutorRunClient } from "@executor-v2/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";

import { PmRunExecutor } from "./run-executor";

export type PmMcpHandlerService = {
  handleMcp: (request: Request) => Promise<Response>;
};

export class PmMcpHandler extends Context.Tag("@executor-v2/app-pm/PmMcpHandler")<
  PmMcpHandler,
  PmMcpHandlerService
>() {}

export const PmMcpHandlerLive = Layer.effect(
  PmMcpHandler,
  Effect.gen(function* () {
    const runExecutor = yield* PmRunExecutor;
    const runtime = yield* Effect.runtime<ToolProviderRegistryService>();
    const runPromise = Runtime.runPromise(runtime);

    const runClient = createExecutorRunClient((input) =>
      runPromise(runExecutor.executeRun(input)),
    );

    const handleMcp = (request: Request): Promise<Response> =>
      handleMcpHttpRequest(request, {
        target: "local",
        serverName: "executor-v2-pm",
        serverVersion: "0.0.0",
        runClient,
      });

    return PmMcpHandler.of({
      handleMcp,
    });
  }),
);

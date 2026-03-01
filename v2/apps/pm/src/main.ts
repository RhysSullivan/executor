import * as BunContext from "@effect/platform-bun/BunContext";
import { ControlPlaneServiceLive } from "@executor-v2/control-plane";
import { ToolInvocationServiceUnwiredLive } from "@executor-v2/domain";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/engine";
import { LocalSourceStoreLive } from "@executor-v2/persistence-local";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PmConfigLive } from "./config";
import { startPmHttpServer } from "./http-server";
import { PmMcpHandlerLive } from "./mcp-handler";
import {
  PmRunExecutorLive,
  PmToolProviderRegistryLive,
} from "./run-executor";

const runtimeAdapter = makeLocalInProcessRuntimeAdapter();
const PmMcpDependenciesLive = Layer.merge(
  PmRunExecutorLive(runtimeAdapter),
  PmToolProviderRegistryLive,
);

const PmControlPlaneDependenciesLive = ControlPlaneServiceLive.pipe(
  Layer.provide(
    LocalSourceStoreLive({
      rootDir: process.env.PM_STATE_ROOT_DIR ?? ".executor-v2/pm-state",
    }).pipe(Layer.provide(BunContext.layer)),
  ),
);

const PmAppLive = Layer.mergeAll(
  PmConfigLive,
  PmMcpHandlerLive.pipe(Layer.provide(PmMcpDependenciesLive)),
  ToolInvocationServiceUnwiredLive("pm"),
  PmControlPlaneDependenciesLive,
);

const program = Effect.scoped(startPmHttpServer()).pipe(Effect.provide(PmAppLive));

await Effect.runPromise(program);

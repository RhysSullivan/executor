import * as BunContext from "@effect/platform-bun/BunContext";
import { ControlPlaneServiceLive } from "@executor-v2/control-plane";
import { ToolInvocationServiceLive } from "@executor-v2/domain";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/engine";
import {
  LocalSourceStoreLive,
  LocalStateStoreLive,
} from "@executor-v2/persistence-local";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PmConfigLive } from "./config";
import { PmCredentialResolverLive } from "./credential-resolver";
import { startPmHttpServer } from "./http-server";
import { PmMcpHandlerLive } from "./mcp-handler";
import {
  PmRunExecutorLive,
  PmToolProviderRegistryLive,
} from "./run-executor";

const runtimeAdapter = makeLocalInProcessRuntimeAdapter();
const pmStateRootDir = process.env.PM_STATE_ROOT_DIR ?? ".executor-v2/pm-state";

const PmMcpDependenciesLive = Layer.merge(
  PmRunExecutorLive(runtimeAdapter),
  PmToolProviderRegistryLive,
);

const PmSourceStoreLive = LocalSourceStoreLive({
  rootDir: pmStateRootDir,
}).pipe(Layer.provide(BunContext.layer));

const PmStateStoreLive = LocalStateStoreLive({
  rootDir: pmStateRootDir,
}).pipe(Layer.provide(BunContext.layer));

const PmControlPlaneDependenciesLive = ControlPlaneServiceLive.pipe(
  Layer.provide(PmSourceStoreLive),
);

const PmToolInvocationDependenciesLive = ToolInvocationServiceLive("pm").pipe(
  Layer.provide(PmCredentialResolverLive.pipe(Layer.provide(PmStateStoreLive))),
);

const PmMcpHandlerDependenciesLive = Layer.merge(
  PmMcpDependenciesLive,
  PmControlPlaneDependenciesLive,
);

const PmAppLive = Layer.mergeAll(
  PmConfigLive,
  PmMcpHandlerLive.pipe(Layer.provide(PmMcpHandlerDependenciesLive)),
  PmToolInvocationDependenciesLive,
  PmControlPlaneDependenciesLive,
);

const program = Effect.scoped(startPmHttpServer()).pipe(Effect.provide(PmAppLive));

await Effect.runPromise(program);

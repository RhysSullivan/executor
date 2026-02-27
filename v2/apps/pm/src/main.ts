import * as BunContext from "@effect/platform-bun/BunContext";
import { ControlPlaneServiceLive } from "@executor-v2/control-plane";
import {
  RunExecutionServiceLive,
  RuntimeToolInvokerUnimplementedLive,
  ToolInvocationServiceLive,
} from "@executor-v2/domain";
import {
  RuntimeAdapterRegistryLive,
  ToolProviderRegistryService,
  makeCloudflareWorkerLoaderRuntimeAdapter,
  makeDenoSubprocessRuntimeAdapter,
  makeLocalInProcessRuntimeAdapter,
  makeToolProviderRegistry,
  type RuntimeAdapterKind,
} from "@executor-v2/engine";
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

const pmStateRootDir = process.env.PM_STATE_ROOT_DIR ?? ".executor-v2/pm-state";

const parsePmRuntimeKind = (value: string | undefined): RuntimeAdapterKind => {
  if (!value || value.trim().length === 0) {
    return "local-inproc";
  }

  const normalized = value.trim();

  switch (normalized) {
    case "local-inproc":
    case "deno-subprocess":
    case "cloudflare-worker-loader":
      return normalized;
    default:
      throw new Error(
        `Invalid PM_RUNTIME_KIND '${value}'. Expected one of: local-inproc, deno-subprocess, cloudflare-worker-loader.`,
      );
  }
};

const pmRuntimeKind = parsePmRuntimeKind(process.env.PM_RUNTIME_KIND);

const PmRuntimeAdapterRegistryLive = RuntimeAdapterRegistryLive([
  makeLocalInProcessRuntimeAdapter(),
  makeDenoSubprocessRuntimeAdapter(),
  makeCloudflareWorkerLoaderRuntimeAdapter(),
]);

const PmToolProviderRegistryLive = Layer.succeed(
  ToolProviderRegistryService,
  makeToolProviderRegistry([]),
);

const PmRuntimeExecutionDependenciesLive = Layer.merge(
  PmRuntimeAdapterRegistryLive,
  PmToolProviderRegistryLive,
);

const PmRunExecutionLive = RunExecutionServiceLive({
  target: "pm",
  defaultRuntimeKind: pmRuntimeKind,
}).pipe(Layer.provide(PmRuntimeExecutionDependenciesLive));

const PmSourceStoreLive = LocalSourceStoreLive({
  rootDir: pmStateRootDir,
}).pipe(Layer.provide(BunContext.layer));

const PmStateStoreLive = LocalStateStoreLive({
  rootDir: pmStateRootDir,
}).pipe(Layer.provide(BunContext.layer));

const PmControlPlaneDependenciesLive = ControlPlaneServiceLive.pipe(
  Layer.provide(PmSourceStoreLive),
);

const PmToolInvocationDependenciesLive = ToolInvocationServiceLive.pipe(
  Layer.provide(RuntimeToolInvokerUnimplementedLive("pm")),
  Layer.provide(PmCredentialResolverLive.pipe(Layer.provide(PmStateStoreLive))),
);

const PmAppLive = Layer.mergeAll(
  PmConfigLive,
  PmMcpHandlerLive.pipe(Layer.provide(PmRunExecutionLive)),
  PmToolInvocationDependenciesLive,
  PmControlPlaneDependenciesLive,
);

const program = Effect.scoped(startPmHttpServer()).pipe(Effect.provide(PmAppLive));

await Effect.runPromise(program);

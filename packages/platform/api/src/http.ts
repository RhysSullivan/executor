import { HttpApiBuilder } from "@effect/platform";
import * as Layer from "effect/Layer";
import type { Executor } from "@executor/platform-sdk";

import { ExecutorApi } from "./api";
import { createControlPlaneExecutorLayer } from "./executor-context";
import { ExecutorExecutionsLive } from "./executions/http";
import { ExecutorLocalLive } from "./local/http";
import { ExecutorOAuthLive } from "./oauth/http";
import { ExecutorPoliciesLive } from "./policies/http";
import { ExecutorSourcesLive } from "./sources/http";

export const ExecutorApiLive = HttpApiBuilder.api(ExecutorApi).pipe(
  Layer.provide(ExecutorLocalLive),
  Layer.provide(ExecutorOAuthLive),
  Layer.provide(ExecutorSourcesLive),
  Layer.provide(ExecutorPoliciesLive),
  Layer.provide(ExecutorExecutionsLive),
);

export type ExecutorApiRuntimeContext = Layer.Layer.Context<typeof ExecutorApiLive>;

export const createExecutorApiLayer = (executor: Executor) =>
  ExecutorApiLive.pipe(
    Layer.provide(createControlPlaneExecutorLayer(executor)),
  );

export type BuiltExecutorApiLayer = ReturnType<
  typeof createExecutorApiLayer
>;

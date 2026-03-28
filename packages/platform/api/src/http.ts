import { HttpApiBuilder } from "@effect/platform";
import * as Layer from "effect/Layer";
import type { ExecutorEffect } from "@executor/platform-sdk/effect";

import { createExecutorApi } from "./api";
import { createControlPlaneExecutorLayer } from "./executor-context";
import { ExecutorExecutionsLive } from "./executions/http";
import { ExecutorLocalLive } from "./local/http";
import { ExecutorPoliciesLive } from "./policies/http";
import type { ExecutorHttpPlugin } from "./plugins";
import { ExecutorSourcesLive } from "./sources/http";

const createExecutorApiLive = (
  executor: ExecutorEffect,
  plugins: readonly ExecutorHttpPlugin[] = [],
) => {
  const api = createExecutorApi({ plugins });
  let live: Layer.Layer<any, any, any> = HttpApiBuilder.api(api as any).pipe(
    Layer.provide(ExecutorLocalLive),
    Layer.provide(ExecutorSourcesLive),
    Layer.provide(ExecutorPoliciesLive),
    Layer.provide(ExecutorExecutionsLive),
  );

  for (const plugin of plugins) {
    live = live.pipe(
      Layer.provide(
        plugin.build({
          executor,
        }),
      ),
    );
  }

  return live;
};

export const createExecutorApiLayer = (
  executor: ExecutorEffect,
  options: {
    plugins?: readonly ExecutorHttpPlugin[];
  } = {},
) =>
  createExecutorApiLive(executor, options.plugins).pipe(
    Layer.provide(createControlPlaneExecutorLayer(executor)),
  );

export type BuiltExecutorApiLayer = ReturnType<
  typeof createExecutorApiLayer
>;

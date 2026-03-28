import type { HttpApiGroup } from "@effect/platform";
import type * as Layer from "effect/Layer";
import type { ExecutorEffect } from "@executor/platform-sdk/effect";

export type ExecutorHttpApiExtension<
  TGroup extends HttpApiGroup.HttpApiGroup.Any = HttpApiGroup.HttpApiGroup.Any,
> = {
  key: string;
  group: TGroup;
};

export type ExecutorHttpPlugin<
  TGroup extends HttpApiGroup.HttpApiGroup.Any = HttpApiGroup.HttpApiGroup.Any,
  TExecutorExtension extends object = {},
> = ExecutorHttpApiExtension<TGroup> & {
  build(input: {
    executor: ExecutorEffect & TExecutorExtension;
  }): Layer.Layer<any, any, any>;
};

export type ExecutorHttpPluginGroups<
  TPlugins extends readonly ExecutorHttpApiExtension[],
> = TPlugins[number]["group"];

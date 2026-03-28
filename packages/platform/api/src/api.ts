import { HttpApi, OpenApi } from "@effect/platform";
import type { HttpApiGroup } from "@effect/platform";

import { ExecutionsApi } from "./executions/api";
import { LocalApi } from "./local/api";
import { PoliciesApi } from "./policies/api";
import { SourcesApi } from "./sources/api";
import type {
  ExecutorHttpApiExtension,
  ExecutorHttpPlugin,
  ExecutorHttpPluginGroups,
} from "./plugins";

export const CoreExecutorApi = HttpApi.make("executor")
  .add(LocalApi)
  .add(SourcesApi)
  .add(PoliciesApi)
  .add(ExecutionsApi)
  .annotateContext(
    OpenApi.annotations({
      title: "Executor API",
      description: "Local-first API for workspace sources, policies, auth, and execution",
    }),
  );

type HttpApiGroupsOf<TApi> = TApi extends HttpApi.HttpApi<any, infer TGroups, any, any>
  ? TGroups
  : never;
type HttpApiErrorOf<TApi> = TApi extends HttpApi.HttpApi<any, any, infer TError, any>
  ? TError
  : never;
type HttpApiContextOf<TApi> = TApi extends HttpApi.HttpApi<any, any, any, infer TContext>
  ? TContext
  : never;

export type CoreExecutorApiGroups = HttpApiGroupsOf<typeof CoreExecutorApi>;
export type ExecutorApiWithPlugins<
  TPlugins extends readonly ExecutorHttpApiExtension[] = [],
> = HttpApi.HttpApi<
  "executor",
  CoreExecutorApiGroups | ExecutorHttpPluginGroups<TPlugins>,
  HttpApiErrorOf<typeof CoreExecutorApi>,
  HttpApiContextOf<typeof CoreExecutorApi>
>;

export const createExecutorApi = <
  const TPlugins extends readonly ExecutorHttpApiExtension[] = [],
>(
  options: {
    plugins?: TPlugins;
  } = {},
): ExecutorApiWithPlugins<TPlugins> =>
  (options.plugins ?? []).reduce(
    (api, plugin) =>
      api.add(plugin.group as HttpApiGroup.HttpApiGroup.Any),
    CoreExecutorApi as HttpApi.HttpApi<
      "executor",
      CoreExecutorApiGroups | ExecutorHttpPluginGroups<TPlugins>,
      HttpApiErrorOf<typeof CoreExecutorApi>,
      HttpApiContextOf<typeof CoreExecutorApi>
    >,
  );

export const ExecutorApi = createExecutorApi();

export const createExecutorOpenApiSpec = <
  const TPlugins extends readonly ExecutorHttpPlugin[] = [],
>(
  options: {
    plugins?: TPlugins;
  } = {},
) => OpenApi.fromApi(createExecutorApi(options));

export const executorOpenApiSpec = createExecutorOpenApiSpec();

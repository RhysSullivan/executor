import {
  AtomHttpApi,
} from "@effect-atom/atom-react";
import {
  FetchHttpClient,
} from "@effect/platform";
import type * as HttpApi from "@effect/platform/HttpApi";
import type * as HttpApiGroup from "@effect/platform/HttpApiGroup";
import {
  ExecutorApi,
  createExecutorApi,
  type ExecutorHttpApiExtension,
} from "@executor/platform-api";

import { getExecutorApiBaseUrl } from "./base-url";

export const defineExecutorHttpApiClient =
  <Self>() =>
  <
    const Id extends string,
    ApiId extends string,
    Groups extends HttpApiGroup.HttpApiGroup.Any,
    ApiE,
    R,
  >(
    id: Id,
    api: HttpApi.HttpApi<ApiId, Groups, ApiE, R>,
  ) => {
    const build = (baseUrl: string | URL) =>
      AtomHttpApi.Tag<Self>()(id, {
        api,
        httpClient: FetchHttpClient.layer as any,
        baseUrl,
      });

    const cache = new Map<string, ReturnType<typeof build>>();

    return (baseUrl: string | URL = getExecutorApiBaseUrl()) => {
      const key = String(baseUrl);
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }

      const client = build(baseUrl);
      cache.set(key, client);
      return client;
    };
  };

export const defineExecutorPluginHttpApiClient =
  <Self>() =>
  <
    const Id extends string,
    TExtensions extends readonly ExecutorHttpApiExtension[],
  >(
    id: Id,
    extensions: TExtensions,
  ) =>
    defineExecutorHttpApiClient<Self>()(
      id,
      createExecutorApi({
        plugins: extensions,
      }),
    );

export const getExecutorApiHttpClient =
  defineExecutorHttpApiClient<"ExecutorReactHttpClient">()(
    "ExecutorReactHttpClient",
    ExecutorApi,
  );

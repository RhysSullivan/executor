import {
  FetchHttpClient,
  HttpApiClient,
} from "@effect/platform";
import * as Effect from "effect/Effect";

import { createExecutorApi } from "./api";
import type { ExecutorHttpPlugin } from "./plugins";

export const createExecutorApiEffectClient = <
  const TPlugins extends readonly ExecutorHttpPlugin[] = [],
>(input: {
  baseUrl: string;
  plugins?: TPlugins;
}) =>
  HttpApiClient.make(createExecutorApi({ plugins: input.plugins }), {
    baseUrl: input.baseUrl,
  }).pipe(Effect.provide(FetchHttpClient.layer));

export type ExecutorApiEffectClient = Effect.Effect.Success<
  ReturnType<typeof createExecutorApiEffectClient>
>;

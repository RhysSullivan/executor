import {
  FetchHttpClient,
  HttpApiClient,
} from "@effect/platform";
import * as Effect from "effect/Effect";

import { ExecutorApi } from "./api";

export const createExecutorApiClient = (input: {
  baseUrl: string;
  accountId?: string;
}) =>
  HttpApiClient.make(ExecutorApi, {
    baseUrl: input.baseUrl,
  }).pipe(Effect.provide(FetchHttpClient.layer));

export type ExecutorApiClient = Effect.Effect.Success<
  ReturnType<typeof createExecutorApiClient>
>;

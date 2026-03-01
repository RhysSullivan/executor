import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";

import {
  RuntimeAdapterError,
  type RuntimeAdapter,
  type RuntimeAdapterKind,
  type RuntimeExecuteInput,
} from "@executor-v2/engine";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

const runtimeKind: RuntimeAdapterKind = "cloudflare-worker-loader";

export type CloudflareWorkerLoaderConfig = {
  runUrl: string;
  authToken: string;
  callbackUrl: string;
  callbackInternalSecret: string | null;
  requestTimeoutMs: number;
};

export type CloudflareWorkerLoaderRuntimeAdapterOptions = {
  runUrl?: string;
  authToken?: string;
  callbackUrl?: string;
  callbackInternalSecret?: string | null;
  requestTimeoutMs?: number;
  env?: Record<string, string | undefined>;
  httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
};

const defaultRequestTimeoutMs = 120_000;

const CloudflareRunRequestSchema = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  code: Schema.String,
  timeoutMs: Schema.optional(Schema.Number),
  callback: Schema.Struct({
    url: Schema.String,
    internalSecret: Schema.optional(Schema.String),
  }),
});

const CloudflareCompletedRunResponseSchema = Schema.Struct({
  status: Schema.Literal("completed"),
  result: Schema.Unknown,
  error: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
});

const CloudflareFailedRunResponseSchema = Schema.Struct({
  status: Schema.Literal("failed", "timed_out", "denied"),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
});

const CloudflareRunResponseSchema = Schema.Union(
  CloudflareCompletedRunResponseSchema,
  CloudflareFailedRunResponseSchema,
);

type CloudflareRunRequest = typeof CloudflareRunRequestSchema.Type;
type CloudflareRunResponse = typeof CloudflareRunResponseSchema.Type;

const toRuntimeAdapterError = (
  operation: string,
  message: string,
  details: string | null,
): RuntimeAdapterError =>
  new RuntimeAdapterError({
    operation,
    runtimeKind,
    message,
    details,
  });

const describeParseError = (cause: unknown): string =>
  ParseResult.isParseError(cause)
    ? ParseResult.TreeFormatter.formatErrorSync(cause)
    : String(cause);

const normalizeString = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseRequestTimeoutMs = (
  value: string | undefined,
  fallback: number,
): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
};

const resolveConfig = (
  options: CloudflareWorkerLoaderRuntimeAdapterOptions = {},
): CloudflareWorkerLoaderConfig | null => {
  const env = options.env ?? process.env;

  const runUrl = normalizeString(options.runUrl ?? env.CLOUDFLARE_SANDBOX_RUN_URL);
  const authToken = normalizeString(
    options.authToken ?? env.CLOUDFLARE_SANDBOX_AUTH_TOKEN,
  );
  const callbackUrl = normalizeString(
    options.callbackUrl ?? env.CLOUDFLARE_SANDBOX_CALLBACK_URL,
  );
  const callbackInternalSecret =
    options.callbackInternalSecret ??
    normalizeString(
      env.CLOUDFLARE_SANDBOX_CALLBACK_SECRET ??
        env.EXECUTOR_INTERNAL_TOKEN,
    ) ??
    null;

  const requestTimeoutMs =
    options.requestTimeoutMs ??
    parseRequestTimeoutMs(
      env.CLOUDFLARE_SANDBOX_REQUEST_TIMEOUT_MS,
      defaultRequestTimeoutMs,
    );

  if (!runUrl || !authToken || !callbackUrl) {
    return null;
  }

  return {
    runUrl,
    authToken,
    callbackUrl,
    callbackInternalSecret,
    requestTimeoutMs,
  };
};

const makeDispatchRequest = (
  input: RuntimeExecuteInput,
  config: CloudflareWorkerLoaderConfig,
): Effect.Effect<HttpClientRequest.HttpClientRequest, RuntimeAdapterError> => {
  const requestPayload: CloudflareRunRequest = {
    runId: input.runId,
    taskId: input.runId,
    code: input.code,
    timeoutMs: input.timeoutMs,
    callback: {
      url: config.callbackUrl,
      internalSecret: config.callbackInternalSecret ?? undefined,
    },
  };

  const baseRequest = HttpClientRequest.post(config.runUrl).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(config.authToken),
  );

  return HttpClientRequest.schemaBodyJson(CloudflareRunRequestSchema)(
    requestPayload,
  )(baseRequest).pipe(
    Effect.mapError((cause) =>
      toRuntimeAdapterError(
        "encode_request",
        "Failed to encode Cloudflare worker dispatch request",
        describeParseError(cause),
      ),
    ),
  );
};

const executeDispatchRequest = (
  input: RuntimeExecuteInput,
  config: CloudflareWorkerLoaderConfig,
): Effect.Effect<unknown, RuntimeAdapterError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const request = yield* makeDispatchRequest(input, config);

    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError((cause) =>
        toRuntimeAdapterError(
          "dispatch",
          "Cloudflare worker dispatch failed",
          String(cause),
        ),
      ),
    );

    if (response.status !== 200) {
      const body = yield* response.text.pipe(
        Effect.mapError(() => null),
        Effect.orElseSucceed(() => null),
      );

      return yield* toRuntimeAdapterError(
        "dispatch",
        `Cloudflare worker execution returned ${response.status}`,
        body,
      );
    }

    const decodedResponse = yield* HttpClientResponse.schemaBodyJson(
      CloudflareRunResponseSchema,
    )(response).pipe(
      Effect.mapError((cause) =>
        toRuntimeAdapterError(
          "decode_response",
          "Cloudflare worker execution returned invalid response JSON",
          describeParseError(cause),
        ),
      ),
    );

    const runResponse: CloudflareRunResponse = decodedResponse;

    if (runResponse.status === "completed") {
      return runResponse.result;
    }

    return yield* toRuntimeAdapterError(
      "execute_terminal",
      `Cloudflare worker execution ended with status '${runResponse.status}'`,
      typeof runResponse.error === "string" && runResponse.error.length > 0
        ? runResponse.error
        : null,
    );
  });

const provideHttpClientDependencies = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  options: CloudflareWorkerLoaderRuntimeAdapterOptions,
): Effect.Effect<A, E> =>
  effect.pipe(Effect.provide(options.httpClientLayer ?? FetchHttpClient.layer));

const dispatchCodeWithCloudflareWorkerLoader = (
  input: RuntimeExecuteInput,
  config: CloudflareWorkerLoaderConfig,
  options: CloudflareWorkerLoaderRuntimeAdapterOptions,
): Effect.Effect<unknown, RuntimeAdapterError> =>
  Effect.gen(function* () {
    const requestTimeoutMs = Math.max(
      config.requestTimeoutMs,
      (input.timeoutMs ?? 30_000) + 30_000,
    );

    const response = yield* Effect.timeoutOption(
      executeDispatchRequest(input, config),
      requestTimeoutMs,
    );

    if (Option.isNone(response)) {
      return yield* toRuntimeAdapterError(
        "dispatch",
        `Cloudflare worker dispatch timed out after ${requestTimeoutMs}ms`,
        null,
      );
    }

    return response.value;
  }).pipe((effect) => provideHttpClientDependencies(effect, options));

export const makeCloudflareWorkerLoaderRuntimeAdapter = (
  options: CloudflareWorkerLoaderRuntimeAdapterOptions = {},
): RuntimeAdapter => {
  const config = resolveConfig(options);

  return {
    kind: runtimeKind,
    isAvailable: () => Effect.succeed(config !== null),
    execute: (input) => {
      if (!config) {
        return toRuntimeAdapterError(
          "config",
          "Cloudflare worker loader runtime is not configured",
          "Set CLOUDFLARE_SANDBOX_RUN_URL, CLOUDFLARE_SANDBOX_AUTH_TOKEN, and CLOUDFLARE_SANDBOX_CALLBACK_URL.",
        );
      }

      return dispatchCodeWithCloudflareWorkerLoader(input, config, options);
    },
  };
};

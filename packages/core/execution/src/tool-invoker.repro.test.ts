import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ElicitationResponse, ToolResult, createExecutor, definePlugin } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeExecutorToolInvoker } from "./tool-invoker";

const EmptyInputSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({})),
);

const acceptAll = () => Effect.succeed(ElicitationResponse.make({ action: "accept" }));

// Plugins now emit ToolResult directly. Mirrors the structured upstream
// payloads each real plugin extracts a top-line message from — the
// invoker passes the whole ToolResult through unchanged so the model
// in the sandbox sees `r.ok === false` and `r.error.details` carrying
// the full body.
const upstreamErrorPlugin = definePlugin(() => ({
  id: "upstream-error-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "upstream",
      kind: "in-memory",
      name: "Upstream",
      tools: [
        {
          // Microsoft Graph / SharePoint shape: { error: { code, message } }
          name: "sharepointShape",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.succeed(
              ToolResult.fail({
                code: "upstream_http_error",
                status: 400,
                message: 'The expression "foo" is not valid. Provide a valid expression.',
                details: {
                  error: {
                    code: "invalidRequest",
                    message: 'The expression "foo" is not valid. Provide a valid expression.',
                  },
                },
              }),
            ),
        },
        {
          // DealCloud-ish shape: errorCode + errorMessage
          name: "dealcloudShape",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.succeed(
              ToolResult.fail({
                code: "upstream_http_error",
                status: 400,
                message: "Entity 'Deals' has no field 'XYZ'",
                details: {
                  errorCode: 400,
                  errorMessage: "Entity 'Deals' has no field 'XYZ'",
                },
              }),
            ),
        },
        {
          // JSON:API / multi-errors shape
          name: "errorsArrayShape",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.succeed(
              ToolResult.fail({
                code: "upstream_http_error",
                status: 403,
                message: "Insufficient scope",
                details: {
                  errors: [{ status: "403", title: "Forbidden", detail: "Insufficient scope" }],
                },
              }),
            ),
        },
      ],
    },
  ],
}));

const isFailedToolResult = (
  value: unknown,
): value is {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
} =>
  value !== null &&
  typeof value === "object" &&
  "ok" in value &&
  (value as { ok: unknown }).ok === false;

describe("regression: structured upstream failures surface through ToolResult", () => {
  it.effect("SharePoint/Graph nested error.message reaches the sandbox via ToolResult.fail", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [upstreamErrorPlugin()] as const }),
      );
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({ path: "upstream.sharepointShape", args: {} });
      expect(isFailedToolResult(result)).toBe(true);
      if (!isFailedToolResult(result)) return;
      expect(result.error.code).toBe("upstream_http_error");
      expect(result.error.message).toBe(
        'The expression "foo" is not valid. Provide a valid expression.',
      );
      expect(result.error.details).toEqual({
        error: {
          code: "invalidRequest",
          message: 'The expression "foo" is not valid. Provide a valid expression.',
        },
      });
    }),
  );

  it.effect("DealCloud errorMessage reaches the sandbox via ToolResult.fail", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [upstreamErrorPlugin()] as const }),
      );
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({ path: "upstream.dealcloudShape", args: {} });
      expect(isFailedToolResult(result)).toBe(true);
      if (!isFailedToolResult(result)) return;
      expect(result.error.message).toBe("Entity 'Deals' has no field 'XYZ'");
      expect(result.error.details).toMatchObject({
        errorCode: 400,
        errorMessage: "Entity 'Deals' has no field 'XYZ'",
      });
    }),
  );

  it.effect("JSON:API errors[] reaches the sandbox via ToolResult.fail", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [upstreamErrorPlugin()] as const }),
      );
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({ path: "upstream.errorsArrayShape", args: {} });
      expect(isFailedToolResult(result)).toBe(true);
      if (!isFailedToolResult(result)) return;
      expect(result.error.message).toBe("Insufficient scope");
      expect(result.error.details).toMatchObject({
        errors: [{ detail: "Insufficient scope" }],
      });
    }),
  );
});

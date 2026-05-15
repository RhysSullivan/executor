import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";

import { ElicitationResponse, createExecutor, definePlugin } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { ExecutionToolError } from "./errors";
import { makeExecutorToolInvoker } from "./tool-invoker";

const EmptyInputSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({})),
);

const acceptAll = () => Effect.succeed(ElicitationResponse.make({ action: "accept" }));

// Plugin-internal tagged error whose `cause` carries sensitive internal
// context. The dispatcher must route this through the opaque-generic
// path so none of that context reaches the sandbox via Error.message.
class FakeOpenApiInvocationError extends Data.TaggedError("OpenApiInvocationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const leakyPlugin = definePlugin(() => ({
  id: "leaky-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "leaky",
      kind: "in-memory",
      name: "Leaky",
      tools: [
        {
          name: "failsWithCause",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.fail(
              new FakeOpenApiInvocationError({
                message: "HTTP request failed",
                cause: {
                  _tag: "HttpClientError",
                  request: {
                    method: "GET",
                    url: "https://internal.dealcloud/v1/entities?accessToken=SECRET_TOKEN_xyz",
                    headers: { Authorization: "Bearer SECRET_TOKEN_xyz" },
                  },
                  stack:
                    "Error: ECONNREFUSED\n    at /home/svc/executor/packages/plugins/openapi/...:142:11",
                  dbConnString: "postgres://app:p@ssw0rd@10.0.0.5:5432/executor",
                },
              }),
            ),
        },
        {
          name: "throwsRawError",
          description: "",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.fail(
              Object.assign(
                // oxlint-disable-next-line executor/no-error-constructor -- boundary: leak test deliberately fails with a raw Error + crafted stack to assert the dispatcher's opaque-generic redaction
                new Error("Internal: secret 'sk_live_abcd' rotation failed"),
                {
                  stack:
                    "Error: Internal: secret 'sk_live_abcd' rotation failed\n    at /home/svc/.../secret-store.ts:88",
                },
              ),
            ),
        },
      ],
    },
  ],
}));

describe("internal-error leak audit (opaque defects)", () => {
  it.effect("plugin tagged error: defect surfaces only as opaque generic + correlation id", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [leakyPlugin()] as const }));
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(invoker.invoke({ path: "leaky.failsWithCause", args: {} }));
      expect(err).toBeInstanceOf(ExecutionToolError);
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: leak test inspects the rendered message to assert it is the opaque generic
      const msg = (err as { message: string }).message;
      // Must be the canonical opaque shape: "Internal tool error [<hex>]"
      expect(msg).toMatch(/^Internal tool error \[[0-9a-f]{8}\]$/);
      // Crucially, no internal context leaks
      expect(msg).not.toContain("SECRET_TOKEN_xyz");
      expect(msg).not.toContain("p@ssw0rd");
      expect(msg).not.toContain("packages/plugins");
      expect(msg).not.toContain("HttpClientError");
      expect(msg).not.toContain("HTTP request failed");
    }),
  );

  it.effect("plain Error with stack: stack and message do NOT escape", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [leakyPlugin()] as const }));
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const err = yield* Effect.flip(invoker.invoke({ path: "leaky.throwsRawError", args: {} }));
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: leak test inspects the rendered message to assert it is the opaque generic
      const msg = (err as { message: string }).message;
      expect(msg).toMatch(/^Internal tool error \[[0-9a-f]{8}\]$/);
      expect(msg).not.toContain("secret-store.ts");
      expect(msg).not.toContain("at /home/");
      expect(msg).not.toContain("sk_live_abcd");
    }),
  );
});

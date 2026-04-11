import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect } from "effect";

import { createExecutor } from "./executor";
import { PolicyDeniedError } from "./errors";
import { ToolId, ScopeId } from "./ids";
import { makeInMemoryPolicyEngine } from "./in-memory/policy-engine";
import { makeInMemorySecretStore } from "./in-memory/secret-store";
import { makeInMemoryToolRegistry } from "./in-memory/tool-registry";
import { ToolAnnotations, ToolInvocationResult, ToolRegistration, type InvokeOptions } from "./tools";
import { makeInMemorySourceRegistry } from "./sources";
import { ElicitationResponse } from "./elicitation";

const scope = {
  id: ScopeId.make("policy-test-scope"),
  name: "/tmp/policy-test-scope",
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
};

const makeExecutorWithAnnotatedTool = () =>
  Effect.gen(function* () {
    const tools = makeInMemoryToolRegistry();
    const toolId = ToolId.make("openapi.stripe.charges.create");

    yield* tools.register([
      new ToolRegistration({
        id: toolId,
        pluginKey: "test",
        sourceId: "stripe",
        name: "create-charge",
        mayElicit: true,
      }),
    ]);

    yield* tools.registerInvoker("test", {
      resolveAnnotations: () =>
        Effect.succeed(
          new ToolAnnotations({
            requiresApproval: true,
            approvalDescription: "POST /v1/charges",
          }),
        ),
      invoke: () =>
        Effect.succeed(
          new ToolInvocationResult({
            data: { ok: true },
            error: null,
          }),
        ),
    });

    const executor = yield* createExecutor({
      scope,
      tools,
      sources: makeInMemorySourceRegistry(),
      secrets: makeInMemorySecretStore(),
      policies: makeInMemoryPolicyEngine(),
    });

    return { executor, toolId };
  });

describe("policy integration", () => {
  it.effect("fallback preserves annotation-based approval", () =>
    Effect.gen(function* () {
      const { executor, toolId } = yield* makeExecutorWithAnnotatedTool();
      let approvalSource: string | undefined;

      yield* executor.tools.invoke(toolId, {}, {
        onElicitation: (ctx) => {
          approvalSource = ctx.approval?.source;
          return Effect.succeed(new ElicitationResponse({ action: "accept" }));
        },
      });

      expect(approvalSource).toBe("annotation");
    }),
  );

  it.effect("allow-auto policy skips annotation approval", () =>
    Effect.gen(function* () {
      const { executor, toolId } = yield* makeExecutorWithAnnotatedTool();
      let approvalCalls = 0;

      yield* executor.policies.add({
        toolPattern: toolId,
        effect: "allow",
        approvalMode: "auto",
        priority: 0,
        enabled: true,
      });

      const options: InvokeOptions = {
        onElicitation: () => {
          approvalCalls += 1;
          return Effect.succeed(new ElicitationResponse({ action: "accept" }));
        },
      };

      const result = yield* executor.tools.invoke(toolId, {}, options);
      expect(result.data).toEqual({ ok: true });
      expect(approvalCalls).toBe(0);
    }),
  );

  it.effect("allow-required policy triggers approval with policy metadata", () =>
    Effect.gen(function* () {
      const { executor, toolId } = yield* makeExecutorWithAnnotatedTool();

      const policy = yield* executor.policies.add({
        toolPattern: toolId,
        effect: "allow",
        approvalMode: "required",
        priority: 0,
        enabled: true,
      });

      let approvalSource: string | undefined;
      let matchedPolicyId: string | undefined;

      yield* executor.tools.invoke(toolId, {}, {
        onElicitation: (ctx) => {
          approvalSource = ctx.approval?.source;
          matchedPolicyId = ctx.approval?.matchedPolicyId;
          return Effect.succeed(new ElicitationResponse({ action: "accept" }));
        },
      });

      expect(approvalSource).toBe("policy");
      expect(matchedPolicyId).toBe(policy.id);
    }),
  );

  it.effect("deny policy fails before invocation", () =>
    Effect.gen(function* () {
      const { executor, toolId } = yield* makeExecutorWithAnnotatedTool();

      const policy = yield* executor.policies.add({
        toolPattern: toolId,
        effect: "deny",
        approvalMode: "auto",
        priority: 0,
        enabled: true,
      });

      const error = yield* Effect.flip(
        executor.tools.invoke(toolId, {}, { onElicitation: "accept-all" }),
      );

      expect(error).toBeInstanceOf(PolicyDeniedError);
      if (!(error instanceof PolicyDeniedError)) {
        throw new Error(`Expected PolicyDeniedError, got ${error._tag}`);
      }
      expect(error.policyId).toBe(policy.id);
      expect(error.toolId).toBe(toolId);
    }),
  );
});

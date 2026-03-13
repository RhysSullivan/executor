import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeToolInvokerFromTools } from "@executor/codemode-core";
import { makeDenoSubprocessExecutor } from "@executor/runtime-deno-subprocess";

import {
  createSqlControlPlaneRuntime,
  type ResolveExecutionEnvironment,
} from "./index";
import { withControlPlaneClient } from "./test-http-client";

const gatedEchoElicitation = {
  message: "Approve gated echo?",
  requestedSchema: {
    type: "object",
    properties: {
      approve: {
        type: "boolean",
        title: "Approve",
      },
    },
    required: ["approve"],
  },
} as const;

const makeReplayResolver = (countedCalls: { value: number }): ResolveExecutionEnvironment =>
  ({ onElicitation }) =>
    Effect.succeed({
      executor: makeDenoSubprocessExecutor(),
      toolInvoker: makeToolInvokerFromTools({
        onElicitation,
        tools: {
          "counted.add": {
            description: "Adds numbers and counts calls",
            inputSchema: Schema.standardSchemaV1(
              Schema.Struct({
                a: Schema.optional(Schema.Number),
                b: Schema.optional(Schema.Number),
              }),
            ),
            execute: ({ a, b }: { a?: number; b?: number }) => {
              countedCalls.value += 1;
              return { sum: (a ?? 0) + (b ?? 0) };
            },
          },
          "gated.echo": {
            tool: {
              description: "Echoes only after approval",
              inputSchema: Schema.standardSchemaV1(
                Schema.Struct({
                  value: Schema.String,
                  approve: Schema.optional(Schema.Boolean),
                }),
              ),
              execute: ({ value, approve }: { value: string; approve?: boolean }) => ({
                text: approve === true ? `approved:${value}` : `denied:${value}`,
              }),
            },
            metadata: {
              interaction: "required",
              elicitation: gatedEchoElicitation,
            },
          },
        },
      }),
    });

const createRuntime = (countedCalls: { value: number }) =>
  Effect.acquireRelease(
    createSqlControlPlaneRuntime({
      localDataDir: ":memory:",
      executionResolver: makeReplayResolver(countedCalls),
    }),
    (runtime) => Effect.promise(() => runtime.close()).pipe(Effect.orDie),
  );

describe("execution replay", () => {
  it.scoped("replays completed proxy calls instead of re-executing them", () =>
    Effect.gen(function* () {
      const countedCalls = { value: 0 };
      const runtime = yield* createRuntime(countedCalls);
      const installation = runtime.localInstallation;

      const created = yield* withControlPlaneClient(
        {
          runtime,
          accountId: installation.accountId,
        },
        (client) =>
          client.executions.create({
            path: {
              workspaceId: installation.workspaceId,
            },
            payload: {
              code: [
                "const sum = await tools.counted.add({ a: 20, b: 22 });",
                'const echo = await tools.gated.echo({ value: "from-replay" });',
                "return { sum, echo };",
              ].join("\n"),
            },
          }),
      );

      expect(created.execution.status).toBe("waiting_for_interaction");
      expect(countedCalls.value).toBe(1);

      const resumed = yield* withControlPlaneClient(
        {
          runtime,
          accountId: installation.accountId,
        },
        (client) =>
          client.executions.resume({
            path: {
              workspaceId: installation.workspaceId,
              executionId: created.execution.id,
            },
            payload: {
              responseJson: JSON.stringify({
                action: "accept",
                content: {
                  approve: true,
                },
              }),
            },
          }),
      );

      expect(resumed.execution.status).toBe("completed");
      expect(countedCalls.value).toBe(1);
      expect(resumed.execution.resultJson).toBe(
        JSON.stringify({
          sum: { sum: 42 },
          echo: { text: "approved:from-replay" },
        }),
      );

      const completedSteps = yield* runtime.persistence.rows.executionSteps.listByExecutionId(
        created.execution.id,
      );
      expect(completedSteps).toHaveLength(0);
    }),
  );

  it.scoped("keeps live form interactions in the same run when requested", () =>
    Effect.gen(function* () {
      const countedCalls = { value: 0 };
      const runtime = yield* createRuntime(countedCalls);
      const installation = runtime.localInstallation;

      const created = yield* withControlPlaneClient(
        {
          runtime,
          accountId: installation.accountId,
        },
        (client) =>
          client.executions.create({
            path: {
              workspaceId: installation.workspaceId,
            },
            payload: {
              interactionMode: "live_form",
              code: [
                "const nonce = String(Math.random());",
                "return await tools.gated.echo({ value: nonce });",
              ].join("\n"),
            },
          }),
      );

      expect(created.execution.status).toBe("waiting_for_interaction");

      const resumed = yield* withControlPlaneClient(
        {
          runtime,
          accountId: installation.accountId,
        },
        (client) =>
          client.executions.resume({
            path: {
              workspaceId: installation.workspaceId,
              executionId: created.execution.id,
            },
            payload: {
              interactionMode: "live_form",
              responseJson: JSON.stringify({
                action: "accept",
                content: {
                  approve: true,
                },
              }),
            },
          }),
      );

      expect(resumed.execution.status).toBe("completed");
      expect(resumed.execution.resultJson).toContain("approved:");
    }),
  );

  it.scoped("fails loudly when replayed code reaches a different proxy call", () =>
    Effect.gen(function* () {
      const countedCalls = { value: 0 };
      const runtime = yield* createRuntime(countedCalls);
      const installation = runtime.localInstallation;

      const created = yield* withControlPlaneClient(
        {
          runtime,
          accountId: installation.accountId,
        },
        (client) =>
          client.executions.create({
            path: {
              workspaceId: installation.workspaceId,
            },
            payload: {
              code: [
                "await tools.counted.add({ a: 1, b: 2 });",
                'return await tools.gated.echo({ value: "mismatch" });',
              ].join("\n"),
            },
          }),
      );

      expect(created.execution.status).toBe("waiting_for_interaction");
      expect(countedCalls.value).toBe(1);

      yield* runtime.persistence.rows.executions.update(created.execution.id, {
        code: [
          "await tools.counted.add({ a: 1, b: 999 });",
          'return await tools.gated.echo({ value: "mismatch" });',
        ].join("\n"),
        updatedAt: Date.now(),
      });

      const resumed = yield* withControlPlaneClient(
        {
          runtime,
          accountId: installation.accountId,
        },
        (client) =>
          client.executions.resume({
            path: {
              workspaceId: installation.workspaceId,
              executionId: created.execution.id,
            },
            payload: {
              responseJson: JSON.stringify({
                action: "accept",
                content: {
                  approve: true,
                },
              }),
            },
          }),
      );

      expect(resumed.execution.status).toBe("failed");
      expect(resumed.execution.errorText).toContain("Durable execution mismatch");
      expect(countedCalls.value).toBe(1);

      const failedSteps = yield* runtime.persistence.rows.executionSteps.listByExecutionId(
        created.execution.id,
      );
      expect(failedSteps).toHaveLength(0);
    }),
  );
});

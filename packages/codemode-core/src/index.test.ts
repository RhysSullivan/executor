import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/TestClock";

import {
  allowAllToolInteractions,
  createToolCatalogDiscovery,
  createToolCatalogFromTools,
  createStaticDiscoveryFromTools,
  createSystemToolMap,
  makeToolInvokerFromTools,
  mergeToolMaps,
  standardSchemaFromJsonSchema,
  ToolInteractionDeniedError,
  ToolInteractionPendingError,
  toTool,
  type ToolCatalog,
  type CodeExecutor,
  type ToolDescriptor,
  type ToolMap,
  type ToolPath,
} from "./index";

const asToolPath = (value: string): ToolPath => value as ToolPath;

const numberPairInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    a: Schema.Number,
    b: Schema.Number,
  }),
);

const titleInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    title: Schema.String,
  }),
);

const messageInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    message: Schema.String,
  }),
);


describe("codemode-core", () => {
  it.effect("builds static discovery from tool map keys", () =>
    Effect.gen(function* () {
      const tools = {
        "math.add": {
          description: "Add two numbers",
          inputSchema: numberPairInputSchema,
          execute: async ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
        },
        "issues.create": toTool({
          tool: {
            description: "Create issue",
            inputSchema: titleInputSchema,
            execute: async ({ title }: { title: string }) => ({ id: "issue_1", title }),
          },
          metadata: {
            interaction: "required",
          },
        }),
      } satisfies ToolMap;

      const staticDiscovery = createStaticDiscoveryFromTools({
        tools,
        sourceKey: "api.demo",
      });

      expect(staticDiscovery.tools.map((tool) => tool.path)).toEqual([
        "issues.create",
        "math.add",
      ]);

      const createIssueDescriptor = staticDiscovery.tools.find(
        (tool) => tool.path === "issues.create",
      );
      expect(createIssueDescriptor?.interaction).toBe("required");
      expect(createIssueDescriptor?.sourceKey).toBe("api.demo");
      expect(yield* staticDiscovery.executeDescription).toBe(
        [
          "Execute TypeScript in sandbox; call tools directly.",
          "Available tools:",
          "- issues.create: Create issue",
          "- math.add: Add two numbers",
          "Do not use fetch; use tools.* only.",
        ].join("\n"),
      );
    }),
  );


  it.effect("returns pending interaction error for required tools", () =>
    Effect.gen(function* () {
      const invoker = makeToolInvokerFromTools({
        tools: {
          "issues.create": toTool({
            tool: {
              inputSchema: titleInputSchema,
              execute: ({ title }: { title: string }) => ({ id: "issue_1", title }),
            },
            metadata: {
              interaction: "required",
            },
          }),
        },
      });

      const pendingError = yield* Effect.flip(
        invoker.invoke({
          path: "issues.create",
          args: { title: "hello" },
        }),
      );

      expect(pendingError).toBeInstanceOf(ToolInteractionPendingError);
      if (pendingError instanceof ToolInteractionPendingError) {
        expect(pendingError.path).toBe("issues.create");
        expect(pendingError.elicitation.mode).toBe("form");
      }
    }),
  );

  it.effect("waits for elicitation response and executes when accepted", () =>
    Effect.gen(function* () {
      const invoker = makeToolInvokerFromTools({
        tools: {
          "issues.create": toTool({
            tool: {
              inputSchema: titleInputSchema,
              execute: ({ title }: { title: string }) => ({ id: "issue_1", title }),
            },
            metadata: {
              interaction: "required",
            },
          }),
        },
        onElicitation: () =>
          Effect.succeed({
            action: "accept" as const,
          }),
      });

      const output = yield* invoker.invoke({
        path: "issues.create",
        args: { title: "hello" },
        context: { runId: "run_1", callId: "call_1" },
      });

      expect(output).toEqual({ id: "issue_1", title: "hello" });
    }),
  );

  it.effect("waits through polling-style elicitation callback and then executes", () =>
    Effect.gen(function* () {
      let pollingSleeps = 0;

      const invoker = makeToolInvokerFromTools({
        tools: {
          "issues.create": toTool({
            tool: {
              inputSchema: titleInputSchema,
              execute: ({ title }: { title: string }) => ({ id: "issue_1", title }),
            },
            metadata: {
              interaction: "required",
            },
          }),
        },
        onElicitation: () =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 3; attempt += 1) {
              pollingSleeps += 1;
              yield* Effect.sleep("200 seconds");
            }

            return {
              action: "accept" as const,
            };
          }),
      });

      const fiber = yield* invoker.invoke({
        path: "issues.create",
        args: { title: "hello" },
        context: { runId: "run_poll", callId: "call_poll" },
      }).pipe(Effect.fork);

      yield* TestClock.adjust("200 seconds");
      const firstPoll = yield* Fiber.poll(fiber);
      expect(Option.isNone(firstPoll)).toBe(true);

      yield* TestClock.adjust("200 seconds");
      const secondPoll = yield* Fiber.poll(fiber);
      expect(Option.isNone(secondPoll)).toBe(true);

      yield* TestClock.adjust("200 seconds");
      const output = yield* Fiber.join(fiber);

      expect(output).toEqual({ id: "issue_1", title: "hello" });
      expect(pollingSleeps).toBe(3);
    }),
  );

  it.effect("fails when elicitation is declined", () =>
    Effect.gen(function* () {
      const invoker = makeToolInvokerFromTools({
        tools: {
          "issues.create": toTool({
            tool: {
              inputSchema: titleInputSchema,
              execute: ({ title }: { title: string }) => ({ id: "issue_1", title }),
            },
            metadata: {
              interaction: "required",
            },
          }),
        },
        onElicitation: () =>
          Effect.succeed({
            action: "decline" as const,
            content: {
              reason: "User declined tool execution",
            },
          }),
      });

      const declinedError = yield* Effect.flip(
        invoker.invoke({
          path: "issues.create",
          args: { title: "hello" },
        }),
      );

      expect(declinedError).toBeInstanceOf(ToolInteractionDeniedError);
      if (declinedError instanceof ToolInteractionDeniedError) {
        expect(declinedError.reason).toContain("User declined");
      }
    }),
  );

  it.effect("builds Standard Schema validators from JSON Schema", () =>
    Effect.gen(function* () {
      const tools = {
        "math.add": {
          description: "Add two numbers",
          inputSchema: standardSchemaFromJsonSchema({
            type: "object",
            required: ["a", "b"],
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            additionalProperties: false,
          }),
          execute: ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
        },
      } satisfies ToolMap;

      const invoker = makeToolInvokerFromTools({ tools });

      const success = yield* invoker.invoke({
        path: "math.add",
        args: { a: 1, b: 2 },
      });
      expect(success).toEqual({ sum: 3 });

      const failure = yield* Effect.either(
        invoker.invoke({
          path: "math.add",
          args: { a: "1", b: 2 },
        }),
      );

      expect(failure._tag).toBe("Left");
      if (failure._tag === "Left") {
        expect(failure.left).toBeInstanceOf(Error);
        if (failure.left instanceof Error) {
          expect(failure.left.message).toContain("Input validation failed");
        }
      }
    }),
  );

  it.effect("hydrates dynamic discover results via tool catalog", () =>
    Effect.gen(function* () {
      const descriptors: Record<string, ToolDescriptor> = {
        "source.docs.search": {
          path: asToolPath("source.docs.search"),
          sourceKey: "source.docs",
          description: "Search docs",
          inputHint: "object",
          outputHint: "object",
        },
        "source.issues.create": {
          path: asToolPath("source.issues.create"),
          sourceKey: "source.issues",
          description: "Create issue",
          interaction: "required",
          inputHint: "object",
          outputHint: "object",
        },
      };

      const catalog: ToolCatalog = {
        listNamespaces: () =>
          Effect.succeed([
            {
              namespace: "docs",
              displayName: "Docs",
              toolCount: 1,
            },
            {
              namespace: "issues",
              displayName: "Issues",
              toolCount: 1,
            },
          ]),
        listTools: ({ namespace, limit, includeSchemas = false }) =>
          Effect.succeed(
            Object.values(descriptors)
              .filter((descriptor) =>
                !namespace
                  || descriptor.path.startsWith(`${namespace}.`)
                  || descriptor.path.startsWith(`source.${namespace}.`)
              )
              .slice(0, limit)
              .map((descriptor) => ({
                ...descriptor,
                inputSchemaJson: includeSchemas ? descriptor.inputSchemaJson : undefined,
                outputSchemaJson: includeSchemas ? descriptor.outputSchemaJson : undefined,
                refHintKeys: includeSchemas ? descriptor.refHintKeys : undefined,
              })),
          ),
        getToolByPath: ({ path }) =>
          Effect.succeed(descriptors[path] ?? null),
        searchTools: () =>
          Effect.succeed([
            { path: asToolPath("source.issues.create"), score: 0.93 },
            { path: asToolPath("source.docs.search"), score: 0.72 },
          ]),
      };

      const dynamic = createToolCatalogDiscovery({ catalog });

      const namespaces = yield* dynamic.primitives.catalog!.namespaces({ limit: 10 });
      expect(namespaces.namespaces).toHaveLength(2);

      const discovered = yield* dynamic.primitives.discover!({
        query: "create issue",
        limit: 5,
      });

      expect(discovered.bestPath).toBe("source.issues.create");
      expect(discovered.results[0]?.path).toBe("source.issues.create");
      expect(discovered.results[0]?.interaction).toBe("required");
    }),
  );

  it.effect("system tools can be composed as normal tools", () =>
    Effect.gen(function* () {
      const catalog = createToolCatalogFromTools({
        tools: {
          "source.issues.create": toTool({
            tool: {
              description: "Create issue",
              inputSchema: titleInputSchema,
              execute: ({ title }: { title: string }) => ({ id: "issue_1", title }),
            },
            metadata: {
              interaction: "required",
              sourceKey: "source.issues",
            },
          }),
        },
        defaultNamespace: "issues",
      });

      const systemTools = createSystemToolMap({ catalog });
      const allTools = mergeToolMaps([
        {
          "math.add": {
            inputSchema: numberPairInputSchema,
            execute: ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
          },
        },
        systemTools,
      ]);

      const invoker = makeToolInvokerFromTools({ tools: allTools });
      const discovered = yield* invoker.invoke({
        path: "discover",
        args: { query: "create issue", limit: 5 },
      });

      expect(discovered).toMatchObject({
        bestPath: "source.issues.create",
        total: 1,
      });

      const namespaces = yield* invoker.invoke({
        path: "catalog.namespaces",
        args: { limit: 10 },
      });

      expect(namespaces).toEqual({
        namespaces: [
          {
            namespace: "issues",
            toolCount: 1,
          },
        ],
      });
    }),
  );

  it.effect("executes code against tool map via executor contract", () =>
    Effect.gen(function* () {
      const tools = {
        "math.add": {
          inputSchema: numberPairInputSchema,
          execute: async ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
        },
        "notifications.send": toTool({
          tool: {
            inputSchema: messageInputSchema,
            execute: async ({ message }: { message: string }) => ({ delivered: true, message }),
          },
          metadata: { interaction: "required" },
        }),
      } satisfies ToolMap;

      const executor: CodeExecutor = {
        execute: (code, toolInvoker) =>
          Effect.gen(function* () {
            const math = yield* toolInvoker.invoke({
              path: "math.add",
              args: { a: 2, b: 3 },
            });
            const notification = yield* toolInvoker.invoke({
              path: "notifications.send",
              args: { message: "sum is 5" },
            });
            return {
              result: { code, math, notification },
              logs: ["executed"],
            };
          }),
      };

      const code = "return await tools.math.add({ a: 2, b: 3 });";
      const output = yield* executor.execute(
        code,
        makeToolInvokerFromTools({
          tools,
          onToolInteraction: allowAllToolInteractions,
        }),
      );

      expect(output.result).toEqual({
        code,
        math: { sum: 5 },
        notification: { delivered: true, message: "sum is 5" },
      });
      expect(output.logs).toEqual(["executed"]);
    }),
  );

  it.effect("supports lazy tool invoker without passing tools", () =>
    Effect.gen(function* () {
      let mathCalls = 0;

      const toolInvoker = makeToolInvokerFromTools({
        tools: {
          "math.add": {
            inputSchema: numberPairInputSchema,
            execute: ({ a, b }: { a: number; b: number }) => {
              mathCalls += 1;
              return { sum: a + b };
            },
          },
        },
      });

      const executor: CodeExecutor = {
        execute: (code, invoker) =>
          Effect.gen(function* () {
            const math = yield* invoker.invoke({
              path: "math.add",
              args: { a: 20, b: 22 },
            });
            return {
              result: { code, math },
              logs: ["lazy"],
            };
          }),
      };

      const code = "return await tools.math.add({ a: 20, b: 22 });";
      const output = yield* executor.execute(code, toolInvoker);

      expect(mathCalls).toBe(1);
      expect(output.result).toEqual({
        code,
        math: { sum: 42 },
      });
      expect(output.logs).toEqual(["lazy"]);
    }),
  );

  it.effect("surfaces executor-reported errors", () =>
    Effect.gen(function* () {
      const executor: CodeExecutor = {
        execute: (_code, _toolInvoker) =>
          Effect.succeed({ result: null, error: "boom" }),
      };

      const output = yield* executor.execute(
        "return 1",
        makeToolInvokerFromTools({ tools: {} }),
      );

      expect(output.error).toBe("boom");
    }),
  );
});

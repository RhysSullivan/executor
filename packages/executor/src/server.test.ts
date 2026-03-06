import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { startMcpElicitationDemoServer } from "@executor-v3/mcp-elicitation-demo";
import { makeToolInvokerFromTools } from "@executor-v3/codemode-core";
import {
  ControlPlaneStorageError,
  makeControlPlaneClient,
  type ResolveExecutionEnvironment,
} from "@executor-v3/control-plane";
import { makeInProcessExecutor } from "@executor-v3/runtime-local-inproc";

import { seedDemoMcpSourceInWorkspace } from "./dev";
import { makeLocalExecutorServer } from "./server";

const executionResolver: ResolveExecutionEnvironment = () =>
  Effect.succeed({
    executor: makeInProcessExecutor(),
    toolInvoker: makeToolInvokerFromTools({
      tools: {
        "math.add": {
          description: "Add two numbers",
          inputSchema: Schema.standardSchemaV1(
            Schema.Struct({
              a: Schema.optional(Schema.Number),
              b: Schema.optional(Schema.Number),
            }),
          ),
          execute: ({ a, b }) => ({ sum: (a ?? 0) + (b ?? 0) }),
        },
      },
    }),
  });

const makeServer = makeLocalExecutorServer({
  port: 0,
  localDataDir: ":memory:",
  executionResolver,
});

describe("local-executor-server", () => {
  it.scoped("serves the control-plane API and executes code", () =>
    Effect.gen(function* () {
      const server = yield* makeServer;
      const bootstrapClient = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      const execution = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: "return await tools.math.add({ a: 20, b: 22 });",
        },
      });

      expect(execution.execution.status).toBe("completed");
      expect(execution.execution.resultJson).toBe(JSON.stringify({ sum: 42 }));
    }),
  );

  it.scoped("loads MCP sources from control-plane state and resumes elicitation", () =>
    Effect.gen(function* () {
      const demoServer = yield* Effect.acquireRelease(
        Effect.promise(() => startMcpElicitationDemoServer()),
        (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
      );

      const server = yield* makeLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      yield* client.sources.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          name: "Demo",
          kind: "mcp",
          endpoint: demoServer.endpoint,
          status: "connected",
          enabled: true,
          configJson: JSON.stringify({
            namespace: "demo",
            transport: "streamable-http",
          }),
        },
      });

      const created = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: 'return await tools.demo.gated_echo({ value: "from-daemon" });',
        },
      });

      expect(created.execution.status).toBe("waiting_for_interaction");
      expect(created.pendingInteraction).not.toBeNull();
      if (created.pendingInteraction !== null) {
        expect(created.pendingInteraction.kind).toBe("form");
        expect(created.pendingInteraction.payloadJson).toContain("Approve gated echo");
      }

      const resumed = yield* client.executions.resume({
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
      });

      expect(resumed.execution.status).toBe("completed");
      expect(resumed.pendingInteraction).toBeNull();
      expect(resumed.execution.resultJson).toContain("approved:from-daemon");
    }),
  );

  it.scoped("can run the same MCP elicitation flow more than once without interaction id collisions", () =>
    Effect.gen(function* () {
      const demoServer = yield* Effect.acquireRelease(
        Effect.promise(() => startMcpElicitationDemoServer()),
        (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
      );

      const server = yield* makeLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      yield* client.sources.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          name: "Demo",
          kind: "mcp",
          endpoint: demoServer.endpoint,
          status: "connected",
          enabled: true,
          configJson: JSON.stringify({
            namespace: "demo",
            transport: "streamable-http",
          }),
        },
      });

      for (const value of ["first", "second"]) {
        const created = yield* client.executions.create({
          path: {
            workspaceId: installation.workspaceId,
          },
          payload: {
            code: `return await tools.demo.gated_echo({ value: "${value}" });`,
          },
        });

        expect(created.execution.status).toBe("waiting_for_interaction");
        expect(created.pendingInteraction).not.toBeNull();

        const resumed = yield* client.executions.resume({
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
        });

        expect(resumed.execution.status).toBe("completed");
        expect(resumed.execution.resultJson).toContain(`approved:${value}`);
      }
    }),
  );

  it.scoped("updates an existing demo MCP source instead of creating a duplicate", () =>
    Effect.gen(function* () {
      const server = yield* makeLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      const existing = yield* client.sources.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          name: "Demo",
          kind: "mcp",
          endpoint: "http://127.0.0.1:PORT/mcp",
          status: "connected",
          enabled: true,
          configJson: JSON.stringify({
            namespace: "demo",
            transport: "streamable-http",
          }),
        },
      });

      const seeded = yield* seedDemoMcpSourceInWorkspace({
        client,
        workspaceId: installation.workspaceId,
        endpoint: "http://127.0.0.1:58506/mcp",
        name: "Demo",
        namespace: "demo",
      });

      expect(seeded.action).toBe("updated");
      expect(seeded.sourceId).toBe(existing.id);

      const sources = yield* client.sources.list({
        path: {
          workspaceId: installation.workspaceId,
        },
      });

      expect(sources).toHaveLength(1);
      expect(sources[0]?.endpoint).toBe("http://127.0.0.1:58506/mcp");
    }),
  );

  it.scoped("returns a typed storage error when a configured MCP endpoint is invalid", () =>
    Effect.gen(function* () {
      const server = yield* makeLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      yield* client.sources.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          name: "Demo",
          kind: "mcp",
          endpoint: "http://127.0.0.1:PORT/mcp",
          status: "connected",
          enabled: true,
          configJson: JSON.stringify({
            namespace: "demo",
            transport: "streamable-http",
          }),
        },
      });

      const failure = yield* client.executions
        .create({
          path: {
            workspaceId: installation.workspaceId,
          },
          payload: {
            code: 'return await tools.demo.gated_echo({ value: "broken" });',
          },
        })
        .pipe(Effect.flip);

      expect(failure).toBeInstanceOf(ControlPlaneStorageError);
      if (failure instanceof ControlPlaneStorageError) {
        expect(failure.operation).toBe("executions.create.environment");
        expect(failure.message).toContain("Failed creating MCP connector");
      }
    }),
  );
});

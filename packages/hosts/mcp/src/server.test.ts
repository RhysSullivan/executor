import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  FormElicitation,
  UrlElicitation,
  ElicitationResponse,
  type ElicitationHandler,
  type ElicitationContext,
} from "@executor/sdk";
import type { ExecutionEngine, ExecutionResult, PausedExecution } from "@executor/execution";
import type { ExecuteResult } from "@executor/codemode-core";

import { createExecutorMcpServer } from "./server";

// ---------------------------------------------------------------------------
// Helpers — stub engine
// ---------------------------------------------------------------------------

/**
 * Creates a fake ExecutionEngine where `execute` and `executeWithPause`
 * call into caller-provided functions so each test can control behaviour.
 */
const makeStubEngine = (overrides: {
  execute?: ExecutionEngine["execute"];
  executeWithPause?: ExecutionEngine["executeWithPause"];
  resume?: ExecutionEngine["resume"];
  description?: string;
}): ExecutionEngine => ({
  execute: overrides.execute ?? (async () => ({ result: "default" })),
  executeWithPause: overrides.executeWithPause ??
    (async () => ({ status: "completed", result: { result: "default" } })),
  resume: overrides.resume ?? (async () => null),
  getDescription: async () => overrides.description ?? "test executor",
});

// ---------------------------------------------------------------------------
// Helpers — spin up in-memory client ↔ server
// ---------------------------------------------------------------------------

type TestHarness = {
  client: Client;
  close: () => Promise<void>;
};

/**
 * Connect a real MCP Client to our executor MCP server over in-memory
 * transports. The `clientCapabilities` parameter controls whether the
 * client advertises elicitation support.
 */
const connect = async (
  engine: ExecutionEngine,
  clientCapabilities: { elicitation?: { form?: object } } = {},
): Promise<TestHarness> => {
  const mcpServer = await createExecutorMcpServer({ engine });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: clientCapabilities },
  );

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await clientTransport.close();
      await serverTransport.close();
    },
  };
};

// ---------------------------------------------------------------------------
// Tests — client WITH elicitation support (managed / inline path)
// ---------------------------------------------------------------------------

describe("MCP host server — client with elicitation", () => {
  it.effect(
    "execute tool calls engine.execute and returns result",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          execute: async (code, { onElicitation }) => ({
            result: `ran: ${code}`,
          }),
        });

        const { client, close } = await connect(engine, {
          elicitation: { form: {} },
        });

        try {
          const result = await client.callTool({ name: "execute", arguments: { code: "1+1" } });
          expect(result.content).toEqual([{ type: "text", text: "ran: 1+1" }]);
          expect(result.isError).toBeFalsy();
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "form elicitation is bridged from engine to MCP client and back",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          execute: async (code, { onElicitation }) => {
            const response = await Effect.runPromise(
              onElicitation({
                toolId: "test-tool" as any,
                args: { code },
                request: new FormElicitation({
                  message: "Approve this action?",
                  requestedSchema: {
                    type: "object",
                    properties: {
                      approved: { type: "boolean" },
                    },
                  },
                }),
              }),
            );
            return {
              result:
                response.action === "accept" && response.content?.approved
                  ? "approved"
                  : "denied",
            };
          },
        });

        const { client, close } = await connect(engine, {
          elicitation: { form: {} },
        });

        // Register a client-side handler that auto-accepts
        client.setRequestHandler(ElicitRequestSchema, async (request) => ({
          action: "accept" as const,
          content: { approved: true },
        }));

        try {
          const result = await client.callTool({
            name: "execute",
            arguments: { code: "do-it" },
          });
          expect(result.content).toEqual([{ type: "text", text: "approved" }]);
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "form elicitation declined by client → engine sees decline",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          execute: async (code, { onElicitation }) => {
            const response = await Effect.runPromise(
              onElicitation({
                toolId: "t" as any,
                args: {},
                request: new FormElicitation({
                  message: "Accept?",
                  requestedSchema: {},
                }),
              }),
            );
            return { result: `action:${response.action}` };
          },
        });

        const { client, close } = await connect(engine, {
          elicitation: { form: {} },
        });

        client.setRequestHandler(ElicitRequestSchema, async () => ({
          action: "decline" as const,
          content: {},
        }));

        try {
          const result = await client.callTool({
            name: "execute",
            arguments: { code: "x" },
          });
          expect(result.content).toEqual([
            { type: "text", text: "action:decline" },
          ]);
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "empty form schema gets wrapped with minimal valid schema",
    () =>
      Effect.promise(async () => {
        let receivedSchema: unknown;

        const engine = makeStubEngine({
          execute: async (_code, { onElicitation }) => {
            const response = await Effect.runPromise(
              onElicitation({
                toolId: "t" as any,
                args: {},
                request: new FormElicitation({
                  message: "Just approve",
                  requestedSchema: {}, // empty — approval only
                }),
              }),
            );
            return { result: response.action };
          },
        });

        const { client, close } = await connect(engine, {
          elicitation: { form: {} },
        });

        client.setRequestHandler(ElicitRequestSchema, async (request) => {
          receivedSchema = request.params.requestedSchema;
          return { action: "accept" as const, content: {} };
        });

        try {
          await client.callTool({
            name: "execute",
            arguments: { code: "approve" },
          });
          expect(receivedSchema).toEqual({
            type: "object",
            properties: {},
          });
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "UrlElicitation is converted to a form with _url_hint property",
    () =>
      Effect.promise(async () => {
        let receivedMessage: string | undefined;
        let receivedSchema: Record<string, unknown> | undefined;

        const engine = makeStubEngine({
          execute: async (_code, { onElicitation }) => {
            const response = await Effect.runPromise(
              onElicitation({
                toolId: "t" as any,
                args: {},
                request: new UrlElicitation({
                  message: "Please authenticate",
                  url: "https://example.com/oauth",
                  elicitationId: "elic-1",
                }),
              }),
            );
            return { result: response.action };
          },
        });

        const { client, close } = await connect(engine, {
          elicitation: { form: {} },
        });

        client.setRequestHandler(ElicitRequestSchema, async (request) => {
          receivedMessage = request.params.message;
          receivedSchema = request.params.requestedSchema as Record<
            string,
            unknown
          >;
          return { action: "accept" as const, content: {} };
        });

        try {
          await client.callTool({
            name: "execute",
            arguments: { code: "oauth" },
          });
          expect(receivedMessage).toBe("Please authenticate");
          expect(receivedSchema).toEqual({
            type: "object",
            properties: {
              _url_hint: {
                type: "string",
                description:
                  "Please open this URL: https://example.com/oauth",
                default: "https://example.com/oauth",
              },
            },
          });
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "engine error is surfaced as isError result",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          execute: async () => ({
            result: null,
            error: "something broke",
            logs: ["log1"],
          }),
        });

        const { client, close } = await connect(engine, {
          elicitation: { form: {} },
        });

        try {
          const result = await client.callTool({
            name: "execute",
            arguments: { code: "bad" },
          });
          expect(result.isError).toBe(true);
          const text = (result.content as any)[0].text;
          expect(text).toContain("something broke");
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "resume tool is hidden when client supports elicitation",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({});
        const { client, close } = await connect(engine, {
          elicitation: { form: {} },
        });

        try {
          const { tools } = await client.listTools();
          const names = tools.map((t) => t.name);
          expect(names).toContain("execute");
          expect(names).not.toContain("resume");
        } finally {
          await close();
        }
      }),
  );
});

// ---------------------------------------------------------------------------
// Tests — client WITHOUT elicitation (pause/resume path)
// ---------------------------------------------------------------------------

describe("MCP host server — client without elicitation (pause/resume)", () => {
  it.effect(
    "completed execution returns result directly",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          executeWithPause: async () => ({
            status: "completed",
            result: { result: "done" },
          }),
        });

        const { client, close } = await connect(engine);

        try {
          const result = await client.callTool({
            name: "execute",
            arguments: { code: "ok" },
          });
          expect(result.content).toEqual([{ type: "text", text: "done" }]);
          expect(result.isError).toBeFalsy();
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "both execute and resume tools are visible",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({});
        const { client, close } = await connect(engine);

        try {
          const { tools } = await client.listTools();
          const names = tools.map((t) => t.name);
          expect(names).toContain("execute");
          expect(names).toContain("resume");
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "paused execution returns interaction metadata with executionId",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          executeWithPause: async (): Promise<ExecutionResult> => ({
            status: "paused",
            execution: {
              id: "exec_42",
              elicitationContext: {
                toolId: "t" as any,
                args: {},
                request: new FormElicitation({
                  message: "Need approval",
                  requestedSchema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                  },
                }),
              },
              resolve: () => {},
              completion: new Promise(() => {}), // never resolves in this test
            },
          }),
        });

        const { client, close } = await connect(engine);

        try {
          const result = await client.callTool({
            name: "execute",
            arguments: { code: "pause-me" },
          });
          const text = (result.content as any)[0].text as string;
          expect(text).toContain("exec_42");
          expect(text).toContain("Need approval");
          expect(result.isError).toBeFalsy();

          // structuredContent should contain the executionId
          expect((result as any).structuredContent?.executionId).toBe("exec_42");
          expect((result as any).structuredContent?.status).toBe(
            "waiting_for_interaction",
          );
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "resume tool completes a paused execution",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          resume: async (executionId, response) => {
            if (executionId === "exec_1" && response.action === "accept") {
              return { result: "resumed-ok" };
            }
            return null;
          },
        });

        const { client, close } = await connect(engine);

        try {
          const result = await client.callTool({
            name: "resume",
            arguments: {
              executionId: "exec_1",
              action: "accept",
              content: "{}",
            },
          });
          expect(result.content).toEqual([
            { type: "text", text: "resumed-ok" },
          ]);
          expect(result.isError).toBeFalsy();
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "resume tool passes parsed content to engine",
    () =>
      Effect.promise(async () => {
        let receivedContent: Record<string, unknown> | undefined;

        const engine = makeStubEngine({
          resume: async (_id, response) => {
            receivedContent = response.content;
            return { result: "ok" };
          },
        });

        const { client, close } = await connect(engine);

        try {
          await client.callTool({
            name: "resume",
            arguments: {
              executionId: "exec_1",
              action: "accept",
              content: JSON.stringify({ approved: true, name: "test" }),
            },
          });
          expect(receivedContent).toEqual({ approved: true, name: "test" });
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "resume with empty content passes undefined",
    () =>
      Effect.promise(async () => {
        let receivedContent: Record<string, unknown> | undefined = { marker: true };

        const engine = makeStubEngine({
          resume: async (_id, response) => {
            receivedContent = response.content;
            return { result: "ok" };
          },
        });

        const { client, close } = await connect(engine);

        try {
          await client.callTool({
            name: "resume",
            arguments: {
              executionId: "exec_1",
              action: "accept",
              content: "{}",
            },
          });
          expect(receivedContent).toBeUndefined();
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "resume with unknown executionId returns error",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          resume: async () => null,
        });

        const { client, close } = await connect(engine);

        try {
          const result = await client.callTool({
            name: "resume",
            arguments: {
              executionId: "does-not-exist",
              action: "accept",
              content: "{}",
            },
          });
          expect(result.isError).toBe(true);
          const text = (result.content as any)[0].text;
          expect(text).toContain("does-not-exist");
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "paused UrlElicitation includes url and kind in structured output",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          executeWithPause: async (): Promise<ExecutionResult> => ({
            status: "paused",
            execution: {
              id: "exec_99",
              elicitationContext: {
                toolId: "t" as any,
                args: {},
                request: new UrlElicitation({
                  message: "Please authenticate",
                  url: "https://auth.example.com/callback",
                  elicitationId: "elic-url-1",
                }),
              },
              resolve: () => {},
              completion: new Promise(() => {}),
            },
          }),
        });

        const { client, close } = await connect(engine);

        try {
          const result = await client.callTool({
            name: "execute",
            arguments: { code: "oauth" },
          });
          const text = (result.content as any)[0].text as string;
          expect(text).toContain("https://auth.example.com/callback");
          expect(text).toContain("exec_99");

          const structured = (result as any).structuredContent;
          expect(structured?.interaction?.kind).toBe("url");
          expect(structured?.interaction?.url).toBe(
            "https://auth.example.com/callback",
          );
        } finally {
          await close();
        }
      }),
  );
});

// ---------------------------------------------------------------------------
// Tests — elicitation error handling
// ---------------------------------------------------------------------------

describe("MCP host server — elicitation error handling", () => {
  it.effect(
    "elicitInput failure falls back to cancel",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          execute: async (_code, { onElicitation }) => {
            const response = await Effect.runPromise(
              onElicitation({
                toolId: "t" as any,
                args: {},
                request: new FormElicitation({
                  message: "will fail",
                  requestedSchema: {
                    type: "object",
                    properties: { x: { type: "string" } },
                  },
                }),
              }),
            );
            return { result: `fallback:${response.action}` };
          },
        });

        const { client, close } = await connect(engine, {
          elicitation: { form: {} },
        });

        // Don't register any handler — the client will reject with an error
        // when it receives an elicitation request it can't handle.
        // But the MCP SDK might auto-handle... let's explicitly throw.
        client.setRequestHandler(ElicitRequestSchema, async () => {
          throw new Error("client cannot handle this");
        });

        try {
          const result = await client.callTool({
            name: "execute",
            arguments: { code: "fail" },
          });
          // The server catches the error and returns cancel
          expect(result.content).toEqual([
            { type: "text", text: "fallback:cancel" },
          ]);
        } finally {
          await close();
        }
      }),
  );
});

// ---------------------------------------------------------------------------
// Tests — parseJsonContent edge cases
// ---------------------------------------------------------------------------

describe("MCP host server — resume content parsing", () => {
  it.effect(
    "array JSON is rejected (not passed as content)",
    () =>
      Effect.promise(async () => {
        let receivedContent: Record<string, unknown> | undefined = { marker: true };

        const engine = makeStubEngine({
          resume: async (_id, response) => {
            receivedContent = response.content;
            return { result: "ok" };
          },
        });

        const { client, close } = await connect(engine);

        try {
          await client.callTool({
            name: "resume",
            arguments: {
              executionId: "exec_1",
              action: "accept",
              content: "[1,2,3]",
            },
          });
          // Array should be rejected — engine receives undefined
          expect(receivedContent).toBeUndefined();
        } finally {
          await close();
        }
      }),
  );

  it.effect(
    "invalid JSON is handled gracefully (not thrown)",
    () =>
      Effect.promise(async () => {
        let receivedContent: Record<string, unknown> | undefined = { marker: true };

        const engine = makeStubEngine({
          resume: async (_id, response) => {
            receivedContent = response.content;
            return { result: "ok" };
          },
        });

        const { client, close } = await connect(engine);

        try {
          const result = await client.callTool({
            name: "resume",
            arguments: {
              executionId: "exec_1",
              action: "accept",
              content: "not-valid-json",
            },
          });
          // Should not crash — invalid JSON treated as undefined content
          expect(receivedContent).toBeUndefined();
          expect(result.isError).toBeFalsy();
        } finally {
          await close();
        }
      }),
  );
});

// ---------------------------------------------------------------------------
// Tests — multiple elicitations in a single execution
// ---------------------------------------------------------------------------

describe("MCP host server — multiple elicitations", () => {
  it.effect(
    "engine can elicit multiple times during a single execute call",
    () =>
      Effect.promise(async () => {
        const engine = makeStubEngine({
          execute: async (_code, { onElicitation }) => {
            // First elicitation — ask for name
            const r1 = await Effect.runPromise(
              onElicitation({
                toolId: "t" as any,
                args: {},
                request: new FormElicitation({
                  message: "What is your name?",
                  requestedSchema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                }),
              }),
            );

            // Second elicitation — ask for confirmation
            const r2 = await Effect.runPromise(
              onElicitation({
                toolId: "t" as any,
                args: {},
                request: new FormElicitation({
                  message: `Confirm: ${r1.content?.name}?`,
                  requestedSchema: {
                    type: "object",
                    properties: { confirmed: { type: "boolean" } },
                  },
                }),
              }),
            );

            return {
              result: `name=${r1.content?.name},confirmed=${r2.content?.confirmed}`,
            };
          },
        });

        const { client, close } = await connect(engine, {
          elicitation: { form: {} },
        });

        let callCount = 0;
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
          callCount++;
          if (callCount === 1) {
            return { action: "accept" as const, content: { name: "Alice" } };
          }
          return { action: "accept" as const, content: { confirmed: true } };
        });

        try {
          const result = await client.callTool({
            name: "execute",
            arguments: { code: "multi" },
          });
          expect(result.content).toEqual([
            { type: "text", text: "name=Alice,confirmed=true" },
          ]);
          expect(callCount).toBe(2);
        } finally {
          await close();
        }
      }),
  );
});

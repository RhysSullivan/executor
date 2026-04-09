import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

import { FormElicitation, UrlElicitation } from "@executor/sdk";
import type { ExecutionEngine, ExecutionResult } from "@executor/execution";

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
  clientCapabilities: ClientCapabilities = {},
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
  it("execute tool calls engine.execute and returns result", async () => {
    const engine = makeStubEngine({
      execute: async (code) => ({
        result: `ran: ${code}`,
      }),
    });

    const { client, close } = await connect(engine, {
      elicitation: { form: {}, url: {} },
    });

    try {
      const result = await client.callTool({ name: "execute", arguments: { code: "1+1" } });
      expect(result.content).toEqual([{ type: "text", text: "ran: 1+1" }]);
      expect(result.isError).toBeFalsy();
    } finally {
      await close();
    }
  });

  it("form elicitation is bridged from engine to MCP client and back", async () => {
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
      elicitation: { form: {}, url: {} },
    });

    // Register a client-side handler that auto-accepts
    client.setRequestHandler(ElicitRequestSchema, async () => ({
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
  });

  it("form elicitation declined by client → engine sees decline", async () => {
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
      elicitation: { form: {}, url: {} },
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
  });

  it("empty form schema gets wrapped with minimal valid schema", async () => {
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
      elicitation: { form: {}, url: {} },
    });

    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params;
      if ("requestedSchema" in params) {
        receivedSchema = params.requestedSchema;
      }
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
  });

  it("UrlElicitation is sent as native mode:url elicitation", async () => {
    let receivedParams: Record<string, unknown> | undefined;

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
      elicitation: { form: {}, url: {} },
    });

    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      receivedParams = request.params as Record<string, unknown>;
      return { action: "accept" as const, content: {} };
    });

    try {
      await client.callTool({
        name: "execute",
        arguments: { code: "oauth" },
      });
      expect(receivedParams?.mode).toBe("url");
      expect(receivedParams?.message).toBe("Please authenticate");
      expect(receivedParams?.url).toBe("https://example.com/oauth");
      expect(receivedParams?.elicitationId).toBe("elic-1");
    } finally {
      await close();
    }
  });

  it("engine error is surfaced as isError result", async () => {
    const engine = makeStubEngine({
      execute: async () => ({
        result: null,
        error: "something broke",
        logs: ["log1"],
      }),
    });

    const { client, close } = await connect(engine, {
      elicitation: { form: {}, url: {} },
    });

    try {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "bad" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("something broke");
    } finally {
      await close();
    }
  });

  it("resume tool is hidden when client supports elicitation", async () => {
    const engine = makeStubEngine({});
    const { client, close } = await connect(engine, {
      elicitation: { form: {}, url: {} },
    });

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("execute");
      expect(names).not.toContain("resume");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — client with form-only elicitation (uses managed elicitation)
// ---------------------------------------------------------------------------

describe("MCP host server — client with form-only elicitation", () => {
  it("resume tool is hidden when client supports form elicitation", async () => {
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
  });

  it("uses managed elicitation path when client supports form", async () => {
    const engine = makeStubEngine({
      execute: async (code) => ({
        result: `managed: ${code}`,
      }),
    });

    const { client, close } = await connect(engine, {
      elicitation: { form: {} },
    });

    try {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "test" },
      });
      expect(result.content).toEqual([{ type: "text", text: "managed: test" }]);
    } finally {
      await close();
    }
  });

  it("UrlElicitation falls back to form when client lacks url support", async () => {
    let receivedMessage: string | undefined;

    const engine = makeStubEngine({
      execute: async (_code, { onElicitation }) => {
        const response = await Effect.runPromise(
          onElicitation({
            toolId: "t" as any,
            args: {},
            request: new UrlElicitation({
              message: "Please authenticate",
              url: "https://auth.example.com/oauth",
              elicitationId: "elic-1",
            }),
          }),
        );
        return { result: response.action };
      },
    });

    const { client, close } = await connect(engine, {
      elicitation: { form: {} }, // no url support
    });

    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      receivedMessage = (request.params as Record<string, unknown>).message as string;
      return { action: "accept" as const, content: {} };
    });

    try {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "oauth" },
      });
      expect(result.content).toEqual([{ type: "text", text: "accept" }]);
      expect(receivedMessage).toContain("https://auth.example.com/oauth");
      expect(receivedMessage).toContain("Please authenticate");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — client WITHOUT elicitation (pause/resume path)
// ---------------------------------------------------------------------------

describe("MCP host server — client without elicitation (pause/resume)", () => {
  it("completed execution returns result directly", async () => {
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
  });

  it("both execute and resume tools are visible", async () => {
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
  });

  it("paused execution returns interaction metadata with executionId", async () => {
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
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("exec_42");
      expect(text).toContain("Need approval");
      expect(result.isError).toBeFalsy();

      // structuredContent should contain the executionId
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured?.executionId).toBe("exec_42");
      expect(structured?.status).toBe("waiting_for_interaction");
    } finally {
      await close();
    }
  });

  it("resume tool completes a paused execution", async () => {
    const engine = makeStubEngine({
      resume: async (executionId, response) => {
        if (executionId === "exec_1" && response.action === "accept") {
          return { status: "completed", result: { result: "resumed-ok" } };
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
  });

  it("resume tool passes parsed content to engine", async () => {
    let receivedContent: Record<string, unknown> | undefined;

    const engine = makeStubEngine({
      resume: async (_id, response) => {
        receivedContent = response.content;
        return { status: "completed", result: { result: "ok" } };
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
  });

  it("resume with empty content passes undefined", async () => {
    let receivedContent: Record<string, unknown> | undefined = { marker: true };

    const engine = makeStubEngine({
      resume: async (_id, response) => {
        receivedContent = response.content;
        return { status: "completed", result: { result: "ok" } };
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
  });

  it("resume with unknown executionId returns error", async () => {
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
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("does-not-exist");
    } finally {
      await close();
    }
  });

  it("paused UrlElicitation includes url and kind in structured output", async () => {
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
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("https://auth.example.com/callback");
      expect(text).toContain("exec_99");

      const structured = result.structuredContent as Record<string, unknown>;
      const interaction = structured?.interaction as Record<string, unknown>;
      expect(interaction?.kind).toBe("url");
      expect(interaction?.url).toBe("https://auth.example.com/callback");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — elicitation error handling
// ---------------------------------------------------------------------------

describe("MCP host server — elicitation error handling", () => {
  it("elicitInput failure falls back to cancel", async () => {
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
      elicitation: { form: {}, url: {} },
    });

    // Client throws when it receives the elicitation — server should catch
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
  });
});

// ---------------------------------------------------------------------------
// Tests — parseJsonContent edge cases
// ---------------------------------------------------------------------------

describe("MCP host server — resume content parsing", () => {
  it("array JSON is rejected (not passed as content)", async () => {
    let receivedContent: Record<string, unknown> | undefined = { marker: true };

    const engine = makeStubEngine({
      resume: async (_id, response) => {
        receivedContent = response.content;
        return { status: "completed", result: { result: "ok" } };
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
  });

  it("invalid JSON is handled gracefully (not thrown)", async () => {
    let receivedContent: Record<string, unknown> | undefined = { marker: true };

    const engine = makeStubEngine({
      resume: async (_id, response) => {
        receivedContent = response.content;
        return { status: "completed", result: { result: "ok" } };
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
  });
});

// ---------------------------------------------------------------------------
// Tests — multiple elicitations in a single execution
// ---------------------------------------------------------------------------

describe("MCP host server — multiple elicitations", () => {
  it("engine can elicit multiple times during a single execute call", async () => {
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
      elicitation: { form: {}, url: {} },
    });

    let callCount = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
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
  });
});

import { describe, expect, it } from "vitest";
import { Data, Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type * as Cause from "effect/Cause";

import { FormElicitation, ToolId, UrlElicitation } from "@executor/sdk";
import type { ExecutionEngine, ExecutionResult } from "@executor/execution";

import { createExecutorMcpServer } from "./server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class TestExecutionError extends Data.TaggedError("TestExecutionError")<{
  readonly message: string;
}> {}

const makeStubEngine = <E extends Cause.YieldableError = never>(overrides: {
  execute?: ExecutionEngine<E>["execute"];
  executeWithPause?: ExecutionEngine<E>["executeWithPause"];
  resume?: ExecutionEngine<E>["resume"];
  description?: string;
}): ExecutionEngine<E> => ({
  execute: overrides.execute ?? (() => Effect.succeed({ result: "default" })),
  executeWithPause:
    overrides.executeWithPause ??
    (() => Effect.succeed({ status: "completed", result: { result: "default" } })),
  resume: overrides.resume ?? (() => Effect.succeed(null)),
  getDescription: Effect.succeed(overrides.description ?? "test executor"),
});

/** Connect a real MCP Client to our executor MCP server over in-memory transports. */
const withClient = async <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
  capabilities: ClientCapabilities,
  fn: (client: Client) => Promise<void>,
) => {
  const mcpServer = await Effect.runPromise(createExecutorMcpServer({ engine }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await fn(client);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
  }
};

const ELICITATION_CAPS: ClientCapabilities = {
  elicitation: { form: {}, url: {} },
};
const FORM_ONLY_CAPS: ClientCapabilities = { elicitation: { form: {} } };
const NO_CAPS: ClientCapabilities = {};

/** Extract the first text content from a callTool result. */
const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as Array<{ type: string; text: string }>)[0].text;

const STUB_TOOL_ID = ToolId.make("t");

/** Build a stub paused ExecutionResult with the given id and elicitation request. */
const makePausedResult = (
  id: string,
  request: FormElicitation | UrlElicitation,
): ExecutionResult => ({
  status: "paused",
  execution: {
    id,
    elicitationContext: { toolId: STUB_TOOL_ID, args: {}, request },
  },
});

/** Build an engine whose execute triggers one elicitation and returns the handler's result. */
const makeElicitingEngine = (
  request: FormElicitation | UrlElicitation,
  formatResult: (response: { action: string; content?: Record<string, unknown> }) => unknown = (
    r,
  ) => r.action,
): ExecutionEngine =>
  makeStubEngine({
    execute: (_code, { onElicitation }) =>
      Effect.gen(function* () {
        const response = yield* onElicitation({
          toolId: STUB_TOOL_ID,
          args: {},
          request,
        });
        return { result: formatResult(response) };
      }),
  });

// ---------------------------------------------------------------------------
// Client WITH elicitation support (managed / inline path)
// ---------------------------------------------------------------------------

describe("MCP host server — client with elicitation", () => {
  it("execute tool calls engine.execute and returns result", async () => {
    const engine = makeStubEngine({
      execute: (code) => Effect.succeed({ result: `ran: ${code}` }),
    });

    await withClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "1+1" },
      });
      expect(result.content).toEqual([{ type: "text", text: "ran: 1+1" }]);
      expect(result.isError).toBeFalsy();
    });
  });

  it("execute tool resolves failed engine effects as MCP error results", async () => {
    const engine = makeStubEngine({
      execute: () => Effect.fail(new TestExecutionError({ message: "Unexpected token ':'" })),
    });

    await withClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "const x: any = 1;" },
      });
      expect(textOf(result)).toBe("Error: Unexpected token ':'");
      expect(result.structuredContent).toEqual({
        status: "error",
        error: "Unexpected token ':'",
      });
      expect(result.isError).toBe(true);
    });
  });

  it("execute tool hides defect details in MCP error results", async () => {
    const engine = makeStubEngine({
      execute: () => Effect.die(new Error("secret internal detail")),
    });

    await withClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "run" },
      });
      expect(textOf(result)).toBe("Error: Tool execution failed");
      expect(result.structuredContent).toEqual({
        status: "error",
        error: "Tool execution failed",
      });
      expect(result.isError).toBe(true);
    });
  });

  it("form elicitation is bridged from engine to MCP client and back", async () => {
    const engine = makeElicitingEngine(
      new FormElicitation({
        message: "Approve this action?",
        requestedSchema: {
          type: "object",
          properties: { approved: { type: "boolean" } },
        },
      }),
      (r) => (r.action === "accept" && r.content?.approved ? "approved" : "denied"),
    );

    await withClient(engine, ELICITATION_CAPS, async (client) => {
      client.setRequestHandler(ElicitRequestSchema, async () => ({
        action: "accept" as const,
        content: { approved: true },
      }));

      const result = await client.callTool({
        name: "execute",
        arguments: { code: "do-it" },
      });
      expect(result.content).toEqual([{ type: "text", text: "approved" }]);
    });
  });

  it("form elicitation declined by client → engine sees decline", async () => {
    const engine = makeElicitingEngine(
      new FormElicitation({ message: "Accept?", requestedSchema: {} }),
      (r) => `action:${r.action}`,
    );

    await withClient(engine, ELICITATION_CAPS, async (client) => {
      client.setRequestHandler(ElicitRequestSchema, async () => ({
        action: "decline" as const,
        content: {},
      }));

      const result = await client.callTool({
        name: "execute",
        arguments: { code: "x" },
      });
      expect(result.content).toEqual([{ type: "text", text: "action:decline" }]);
    });
  });

  it("empty form schema gets wrapped with minimal valid schema", async () => {
    let receivedSchema: unknown;
    const engine = makeElicitingEngine(
      new FormElicitation({ message: "Just approve", requestedSchema: {} }),
    );

    await withClient(engine, ELICITATION_CAPS, async (client) => {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        const params = request.params;
        if ("requestedSchema" in params) {
          receivedSchema = params.requestedSchema;
        }
        return { action: "accept" as const, content: {} };
      });

      await client.callTool({
        name: "execute",
        arguments: { code: "approve" },
      });
      expect(receivedSchema).toEqual({ type: "object", properties: {} });
    });
  });

  it("UrlElicitation is sent as native mode:url elicitation", async () => {
    let receivedParams: Record<string, unknown> | undefined;
    const engine = makeElicitingEngine(
      new UrlElicitation({
        message: "Please authenticate",
        url: "https://example.com/oauth",
        elicitationId: "elic-1",
      }),
    );

    await withClient(engine, ELICITATION_CAPS, async (client) => {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        receivedParams = request.params as Record<string, unknown>;
        return { action: "accept" as const, content: {} };
      });

      await client.callTool({
        name: "execute",
        arguments: { code: "oauth" },
      });
      expect(receivedParams?.mode).toBe("url");
      expect(receivedParams?.message).toBe("Please authenticate");
      expect(receivedParams?.url).toBe("https://example.com/oauth");
      expect(receivedParams?.elicitationId).toBe("elic-1");
    });
  });

  it("engine error is surfaced as isError result", async () => {
    const engine = makeStubEngine({
      execute: () =>
        Effect.succeed({
          result: null,
          error: "something broke",
          logs: ["log1"],
        }),
    });

    await withClient(engine, ELICITATION_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "bad" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("something broke");
    });
  });

  it("resume tool is hidden when client supports elicitation", async () => {
    await withClient(makeStubEngine({}), ELICITATION_CAPS, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("execute");
      expect(names).not.toContain("resume");
    });
  });
});

// ---------------------------------------------------------------------------
// Client with form-only elicitation (uses managed elicitation)
// ---------------------------------------------------------------------------

describe("MCP host server — client with form-only elicitation", () => {
  it("resume tool is hidden when client supports form elicitation", async () => {
    await withClient(makeStubEngine({}), FORM_ONLY_CAPS, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("execute");
      expect(tools.map((t) => t.name)).not.toContain("resume");
    });
  });

  it("uses managed elicitation path when client supports form", async () => {
    const engine = makeStubEngine({
      execute: (code) => Effect.succeed({ result: `managed: ${code}` }),
    });

    await withClient(engine, FORM_ONLY_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "test" },
      });
      expect(result.content).toEqual([{ type: "text", text: "managed: test" }]);
    });
  });

  it("UrlElicitation falls back to form when client lacks url support", async () => {
    let receivedMessage: string | undefined;
    const engine = makeElicitingEngine(
      new UrlElicitation({
        message: "Please authenticate",
        url: "https://auth.example.com/oauth",
        elicitationId: "elic-1",
      }),
    );

    await withClient(engine, FORM_ONLY_CAPS, async (client) => {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        receivedMessage = (request.params as Record<string, unknown>).message as string;
        return { action: "accept" as const, content: {} };
      });

      const result = await client.callTool({
        name: "execute",
        arguments: { code: "oauth" },
      });
      expect(result.content).toEqual([{ type: "text", text: "accept" }]);
      expect(receivedMessage).toContain("https://auth.example.com/oauth");
      expect(receivedMessage).toContain("Please authenticate");
    });
  });
});

// ---------------------------------------------------------------------------
// Client WITHOUT elicitation (pause/resume path)
// ---------------------------------------------------------------------------

describe("MCP host server — client without elicitation (pause/resume)", () => {
  it("completed execution returns result directly", async () => {
    const engine = makeStubEngine({
      executeWithPause: () =>
        Effect.succeed({
          status: "completed",
          result: { result: "done" },
        }),
    });

    await withClient(engine, NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "ok" },
      });
      expect(result.content).toEqual([{ type: "text", text: "done" }]);
      expect(result.isError).toBeFalsy();
    });
  });

  it("both execute and resume tools are visible", async () => {
    await withClient(makeStubEngine({}), NO_CAPS, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("execute");
      expect(names).toContain("resume");
    });
  });

  it("paused execution returns interaction metadata with executionId", async () => {
    const engine = makeStubEngine({
      executeWithPause: () =>
        Effect.succeed(
          makePausedResult(
            "exec_42",
            new FormElicitation({
              message: "Need approval",
              requestedSchema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
              },
            }),
          ),
        ),
    });

    await withClient(engine, NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "pause-me" },
      });
      expect(textOf(result)).toContain("exec_42");
      expect(textOf(result)).toContain("Need approval");
      expect(result.isError).toBeFalsy();

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured?.executionId).toBe("exec_42");
      expect(structured?.status).toBe("waiting_for_interaction");
    });
  });

  it("resume tool completes a paused execution", async () => {
    const engine = makeStubEngine({
      resume: (executionId, response) =>
        Effect.succeed(
          executionId === "exec_1" && response.action === "accept"
            ? { status: "completed", result: { result: "resumed-ok" } }
            : null,
        ),
    });

    await withClient(engine, NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "resume",
        arguments: { executionId: "exec_1", action: "accept", content: "{}" },
      });
      expect(result.content).toEqual([{ type: "text", text: "resumed-ok" }]);
      expect(result.isError).toBeFalsy();
    });
  });

  it("resume tool passes parsed content to engine", async () => {
    let receivedContent: Record<string, unknown> | undefined;
    const engine = makeStubEngine({
      resume: (_id, response) =>
        Effect.sync(() => {
          receivedContent = response.content;
          return { status: "completed", result: { result: "ok" } };
        }),
    });

    await withClient(engine, NO_CAPS, async (client) => {
      await client.callTool({
        name: "resume",
        arguments: {
          executionId: "exec_1",
          action: "accept",
          content: JSON.stringify({ approved: true, name: "test" }),
        },
      });
      expect(receivedContent).toEqual({ approved: true, name: "test" });
    });
  });

  it("resume with empty content passes undefined", async () => {
    let receivedContent: Record<string, unknown> | undefined = { marker: true };
    const engine = makeStubEngine({
      resume: (_id, response) =>
        Effect.sync(() => {
          receivedContent = response.content;
          return { status: "completed", result: { result: "ok" } };
        }),
    });

    await withClient(engine, NO_CAPS, async (client) => {
      await client.callTool({
        name: "resume",
        arguments: { executionId: "exec_1", action: "accept", content: "{}" },
      });
      expect(receivedContent).toBeUndefined();
    });
  });

  it("resume with unknown executionId returns error", async () => {
    const engine = makeStubEngine({ resume: () => Effect.succeed(null) });

    await withClient(engine, NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "resume",
        arguments: {
          executionId: "does-not-exist",
          action: "accept",
          content: "{}",
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("does-not-exist");
    });
  });

  it("paused UrlElicitation includes url and kind in structured output", async () => {
    const engine = makeStubEngine({
      executeWithPause: () =>
        Effect.succeed(
          makePausedResult(
            "exec_99",
            new UrlElicitation({
              message: "Please authenticate",
              url: "https://auth.example.com/callback",
              elicitationId: "elic-url-1",
            }),
          ),
        ),
    });

    await withClient(engine, NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "oauth" },
      });
      expect(textOf(result)).toContain("https://auth.example.com/callback");
      expect(textOf(result)).toContain("exec_99");

      const structured = result.structuredContent as Record<string, unknown>;
      const interaction = structured?.interaction as Record<string, unknown>;
      expect(interaction?.kind).toBe("url");
      expect(interaction?.url).toBe("https://auth.example.com/callback");
    });
  });
});

// ---------------------------------------------------------------------------
// Elicitation error handling
// ---------------------------------------------------------------------------

describe("MCP host server — elicitation error handling", () => {
  it("elicitInput failure falls back to cancel", async () => {
    const engine = makeElicitingEngine(
      new FormElicitation({
        message: "will fail",
        requestedSchema: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      }),
      (r) => `fallback:${r.action}`,
    );

    await withClient(engine, ELICITATION_CAPS, async (client) => {
      client.setRequestHandler(ElicitRequestSchema, async () => {
        throw new Error("client cannot handle this");
      });

      const result = await client.callTool({
        name: "execute",
        arguments: { code: "fail" },
      });
      expect(result.content).toEqual([{ type: "text", text: "fallback:cancel" }]);
    });
  });
});

// ---------------------------------------------------------------------------
// Resume content parsing edge cases
// ---------------------------------------------------------------------------

describe("MCP host server — resume content parsing", () => {
  const makeResumeEngine = () => {
    let receivedContent: Record<string, unknown> | undefined = { marker: true };
    const engine = makeStubEngine({
      resume: (_id, response) =>
        Effect.sync(() => {
          receivedContent = response.content;
          return { status: "completed", result: { result: "ok" } };
        }),
    });
    return { engine, getContent: () => receivedContent };
  };

  it("array JSON is rejected (not passed as content)", async () => {
    const { engine, getContent } = makeResumeEngine();

    await withClient(engine, NO_CAPS, async (client) => {
      await client.callTool({
        name: "resume",
        arguments: { executionId: "exec_1", action: "accept", content: "[1,2,3]" },
      });
      expect(getContent()).toBeUndefined();
    });
  });

  it("invalid JSON is handled gracefully (not thrown)", async () => {
    const { engine, getContent } = makeResumeEngine();

    await withClient(engine, NO_CAPS, async (client) => {
      const result = await client.callTool({
        name: "resume",
        arguments: {
          executionId: "exec_1",
          action: "accept",
          content: "not-valid-json",
        },
      });
      expect(getContent()).toBeUndefined();
      expect(result.isError).toBeFalsy();
    });
  });
});

// ---------------------------------------------------------------------------
// Multiple elicitations in a single execution
// ---------------------------------------------------------------------------

describe("MCP host server — multiple elicitations", () => {
  it("engine can elicit multiple times during a single execute call", async () => {
    const engine = makeStubEngine({
      execute: (_code, { onElicitation }) =>
        Effect.gen(function* () {
          const r1 = yield* onElicitation({
            toolId: STUB_TOOL_ID,
            args: {},
            request: new FormElicitation({
              message: "What is your name?",
              requestedSchema: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            }),
          });

          const r2 = yield* onElicitation({
            toolId: STUB_TOOL_ID,
            args: {},
            request: new FormElicitation({
              message: `Confirm: ${r1.content?.name}?`,
              requestedSchema: {
                type: "object",
                properties: { confirmed: { type: "boolean" } },
              },
            }),
          });

          return {
            result: `name=${r1.content?.name},confirmed=${r2.content?.confirmed}`,
          };
        }),
    });

    await withClient(engine, ELICITATION_CAPS, async (client) => {
      let callCount = 0;
      client.setRequestHandler(ElicitRequestSchema, async () => {
        callCount++;
        if (callCount === 1) {
          return { action: "accept" as const, content: { name: "Alice" } };
        }
        return { action: "accept" as const, content: { confirmed: true } };
      });

      const result = await client.callTool({
        name: "execute",
        arguments: { code: "multi" },
      });
      expect(result.content).toEqual([{ type: "text", text: "name=Alice,confirmed=true" }]);
      expect(callCount).toBe(2);
    });
  });
});

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  createExecutor,
  makeTestConfig,
  FormElicitation,
  ElicitationResponse,
  type InvokeOptions,
} from "@executor/sdk";

import { mcpPlugin } from "./plugin";

// ---------------------------------------------------------------------------
// Test MCP server on a real HTTP port
// ---------------------------------------------------------------------------

function createTestMcpServer() {
  const server = new McpServer(
    { name: "elicitation-test-server", version: "1.0.0" },
    { capabilities: {} },
  );

  server.registerTool(
    "gated_echo",
    {
      description: "Asks for approval before echoing a value",
      inputSchema: { value: z.string() },
    },
    async ({ value }: { value: string }) => {
      const response = await server.server.elicitInput({
        mode: "form",
        message: `Approve echo for "${value}"?`,
        requestedSchema: {
          type: "object",
          properties: {
            approved: { type: "boolean", title: "Approve" },
          },
          required: ["approved"],
        },
      });

      if (response.action !== "accept" || !response.content || response.content.approved !== true) {
        return {
          content: [{ type: "text" as const, text: `denied:${value}` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: `approved:${value}` }],
      };
    },
  );

  server.registerTool(
    "simple_echo",
    {
      description: "Echoes a value without elicitation",
      inputSchema: { value: z.string() },
    },
    async ({ value }: { value: string }) => ({
      content: [{ type: "text" as const, text: value }],
    }),
  );

  return server;
}

type TestServer = {
  readonly url: string;
  readonly httpServer: http.Server;
  /** Number of MCP sessions created (each connect = 1 session) */
  readonly sessionCount: () => number;
};

const serveMcpServer = Effect.acquireRelease(
  Effect.async<TestServer, Error>((resume) => {
    const transports = new Map<string, StreamableHTTPServerTransport>();
    let sessions = 0;

    const httpServer = http.createServer(async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          res.writeHead(404);
          res.end("Session not found");
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      // New session — create a fresh McpServer per connection
      const mcpServer = createTestMcpServer();
      sessions++;

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    });

    httpServer.listen(0, () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resume(
        Effect.succeed({
          url: `http://127.0.0.1:${port}`,
          httpServer,
          sessionCount: () => sessions,
        }),
      );
    });
  }),
  ({ httpServer }) =>
    Effect.sync(() => {
      httpServer.close();
    }),
);

// ---------------------------------------------------------------------------
// Helper — create executor with MCP plugin pointed at test server
// ---------------------------------------------------------------------------

const makeTestExecutor = (serverUrl: string) =>
  createExecutor(
    makeTestConfig({
      plugins: [mcpPlugin()] as const,
    }),
  ).pipe(
    Effect.tap((executor) =>
      executor.mcp.addSource({
        transport: "remote",
        name: "test-mcp",
        endpoint: serverUrl,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests — everything goes through executor.tools.invoke()
// ---------------------------------------------------------------------------

describe("MCP elicitation (end-to-end)", () => {
  it.scoped("form elicitation accepted → tool returns approved result", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer;
      const executor = yield* makeTestExecutor(server.url);

      const tools = yield* executor.tools.list();
      const gatedEcho = tools.find((t) => t.name === "gated_echo");
      expect(gatedEcho).toBeDefined();

      const elicitationMessages: string[] = [];

      const options: InvokeOptions = {
        onElicitation: (ctx) => {
          if (ctx.request instanceof FormElicitation) {
            elicitationMessages.push(ctx.request.message);
          }
          return Effect.succeed(
            new ElicitationResponse({
              action: "accept",
              content: { approved: true },
            }),
          );
        },
      };

      const result = yield* executor.tools.invoke(gatedEcho!.id, { value: "hello" }, options);

      expect(result).toMatchObject({
        content: [{ type: "text", text: "approved:hello" }],
      });
      // At least one elicitation should be the MCP server's form
      expect(elicitationMessages.length).toBeGreaterThanOrEqual(1);
      expect(elicitationMessages.some((m) => m.includes('Approve echo for "hello"?'))).toBe(true);
    }),
  );

  it.scoped("form elicitation declined → tool returns denied result", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const gatedEcho = tools.find((t) => t.name === "gated_echo")!;

      // MCP tools have requiresApproval: false — only the MCP server's
      // mid-invocation elicitation reaches the handler, and we decline it.
      const result = yield* executor.tools.invoke(
        gatedEcho.id,
        { value: "nope" },
        {
          onElicitation: () =>
            Effect.succeed(new ElicitationResponse({ action: "decline" })),
        },
      );

      expect(result).toMatchObject({
        content: [{ type: "text", text: "denied:nope" }],
      });
    }),
  );

  it.scoped("tool without elicitation works normally", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const simpleEcho = tools.find((t) => t.name === "simple_echo")!;

      const result = yield* executor.tools.invoke(
        simpleEcho.id,
        { value: "plain" },
        { onElicitation: "accept-all" },
      );

      expect(result).toMatchObject({
        content: [{ type: "text", text: "plain" }],
      });
    }),
  );

  it.scoped("handler receives correct toolId, args, and FormElicitation schema", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const gatedEcho = tools.find((t) => t.name === "gated_echo")!;

      let capturedToolId: string | undefined;
      let capturedArgs: unknown;
      let capturedRequest: unknown;

      yield* executor.tools.invoke(
        gatedEcho.id,
        { value: "ctx-test" },
        {
          onElicitation: (ctx) => {
            capturedToolId = ctx.toolId;
            capturedArgs = ctx.args;
            capturedRequest = ctx.request;
            return Effect.succeed(
              new ElicitationResponse({
                action: "accept",
                content: { approved: true },
              }),
            );
          },
        },
      );

      expect(capturedToolId).toBe(gatedEcho.id);
      expect(capturedArgs).toEqual({ value: "ctx-test" });
      expect(capturedRequest).toBeInstanceOf(FormElicitation);

      const form = capturedRequest as FormElicitation;
      expect(form.message).toContain('Approve echo for "ctx-test"?');
      expect(form.requestedSchema).toEqual({
        type: "object",
        properties: {
          approved: { type: "boolean", title: "Approve" },
        },
        required: ["approved"],
      });
    }),
  );

  it.scoped("connection is reused across multiple tool calls to the same source", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const simpleEcho = tools.find((t) => t.name === "simple_echo")!;
      const gatedEcho = tools.find((t) => t.name === "gated_echo")!;

      // addSource created 1 session during discovery
      expect(server.sessionCount()).toBeGreaterThanOrEqual(1);

      // First tool call — may create a new session (discovery used a
      // different connection that was closed)
      yield* executor.tools.invoke(
        simpleEcho.id,
        { value: "call-1" },
        { onElicitation: "accept-all" },
      );
      const sessionsAfterFirst = server.sessionCount();

      // Second call to a different tool on the same source — should reuse
      yield* executor.tools.invoke(
        simpleEcho.id,
        { value: "call-2" },
        { onElicitation: "accept-all" },
      );
      expect(server.sessionCount()).toBe(sessionsAfterFirst);

      // Third call to yet another tool on the same source — still reused
      yield* executor.tools.invoke(
        gatedEcho.id,
        { value: "call-3" },
        {
          onElicitation: () =>
            Effect.succeed(
              new ElicitationResponse({
                action: "accept",
                content: { approved: true },
              }),
            ),
        },
      );
      expect(server.sessionCount()).toBe(sessionsAfterFirst);
    }),
  );
});

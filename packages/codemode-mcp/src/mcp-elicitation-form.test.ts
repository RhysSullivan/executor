import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { z } from "zod/v4";

import { makeToolInvokerFromTools } from "@executor/codemode-core";
import { makeSesExecutor } from "@executor/runtime-ses";

import {
  createMcpConnectorFromClient,
  discoverMcpToolsFromConnector,
} from "./mcp-tools";

type McpTestPair = {
  server: McpServer;
  client: Client;
};

const registerFormGatedEchoTool = (server: McpServer) => {
  server.registerTool(
    "gated_echo",
    {
      description: "Asks for approval before echoing",
      inputSchema: {
        value: z.string(),
      },
    },
    async ({ value }: { value: string }) => {
      const response = await server.server.elicitInput({
        mode: "form",
        message: `Approve gated echo for ${value}?`,
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
      });

      if (
        response.action !== "accept"
        || !response.content
        || response.content.approve !== true
      ) {
        return {
          content: [{ type: "text", text: "denied" }],
        };
      }

      return {
        content: [{ type: "text", text: `approved:${value}` }],
      };
    },
  );
};

const makeFormElicitationPair = Effect.acquireRelease(
  Effect.promise<McpTestPair>(async () => {
    const server = new McpServer(
      { name: "codemode-mcp-form-elicitation-test-server", version: "1.0.0" },
      { capabilities: {} },
    );

    registerFormGatedEchoTool(server);

    const client = new Client(
      { name: "codemode-mcp-form-elicitation-test-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    return {
      server,
      client,
    };
  }),
  ({ server, client }) =>
    Effect.tryPromise({
      try: async () => {
        await client.close();
        await server.close();
      },
      catch: (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(Effect.orDie),
);

describe("codemode-mcp form elicitation", () => {
  it.scoped("executes form elicitation through runtime callback", () =>
    Effect.gen(function* () {
      const pair = yield* makeFormElicitationPair;
      const elicitationMessages: string[] = [];

      const discovered = yield* discoverMcpToolsFromConnector({
        connect: createMcpConnectorFromClient(pair.client),
        namespace: "source.form",
        sourceKey: "mcp.form",
      });

      const output = yield* makeSesExecutor().execute(
        'return await tools.source.form.gated_echo({ value: "from-form" });',
        makeToolInvokerFromTools({
          tools: discovered.tools,
          onElicitation: ({ elicitation }) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                elicitationMessages.push(elicitation.message);
              });

              return {
                action: "accept" as const,
                content: {
                  approve: true,
                },
              };
            }),
        }),
      );

      expect(output.result).toEqual({
        content: [{ type: "text", text: "approved:from-form" }],
      });
      expect(elicitationMessages).toHaveLength(1);
      expect(elicitationMessages[0]).toContain("Approve gated echo for from-form?");
    }),
  );
});

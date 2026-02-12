import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

async function createDemoPair(responseAction: "accept" | "decline" | "cancel") {
  const server = new McpServer(
    { name: "elicitation-demo-server", version: "0.0.1" },
    { capabilities: {} },
  );

  server.registerTool(
    "approval_demo",
    {
      description: "Demonstrates MCP form elicitation round-trip",
      inputSchema: {},
    },
    async () => {
      const response = await server.server.elicitInput({
        mode: "form",
        message: "Approve demo operation?",
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              oneOf: [
                { const: "approved", title: "Approve" },
                { const: "denied", title: "Deny" },
              ],
            },
          },
          required: ["decision"],
        },
      });

      const approved = response.action === "accept" && response.content?.decision === "approved";
      return {
        content: [{ type: "text", text: approved ? "approved" : "denied" }],
      };
    },
  );

  const client = new Client(
    { name: "elicitation-demo-client", version: "0.0.1" },
    { capabilities: { elicitation: { form: {} } } },
  );

  client.setRequestHandler(ElicitRequestSchema, async () => {
    if (responseAction !== "accept") {
      return { action: responseAction };
    }

    return {
      action: "accept",
      content: { decision: "approved" },
    };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { server, client };
}

test("MCP form elicitation demo accepts response", async () => {
  const { server, client } = await createDemoPair("accept");

  try {
    const result = (await client.callTool({ name: "approval_demo", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    expect(text).toBe("approved");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP form elicitation demo handles decline", async () => {
  const { server, client } = await createDemoPair("decline");

  try {
    const result = (await client.callTool({ name: "approval_demo", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    expect(text).toBe("denied");
  } finally {
    await client.close();
    await server.close();
  }
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type ApprovalDecision = "approved" | "denied";

interface ApprovalRecord {
  id: string;
  action: string;
  justification: string;
  createdAt: number;
  decision: ApprovalDecision;
  decidedAt: number;
}

const approvals: ApprovalRecord[] = [];

const mcp = new McpServer(
  { name: "memory-approval-demo", version: "0.0.1" },
  {
    capabilities: {
      tools: {},
      experimental: {
        elicitation: {
          form: {},
        },
      },
    },
  },
);

mcp.registerTool(
  "dangerous_action",
  {
    description: "Runs a fake dangerous action after explicit approval.",
    inputSchema: {
      action: z.string().min(1),
      justification: z.string().optional(),
    },
  },
  async ({ action, justification }) => {
    const approvalId = `appr_${crypto.randomUUID().slice(0, 8)}`;

    let decision: ApprovalDecision = "denied";

    try {
      const response = await mcp.server.elicitInput({
        mode: "form",
        message: `Approve dangerous action '${action}'?`,
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

      if (response.action === "accept" && response.content?.decision === "approved") {
        decision = "approved";
      }
    } catch (error) {
      console.error("elicitation failed", error);
      decision = "denied";
    }

    const now = Date.now();
    approvals.unshift({
      id: approvalId,
      action,
      justification: justification ?? "",
      createdAt: now,
      decision,
      decidedAt: now,
    });

    if (decision === "denied") {
      return {
        content: [{ type: "text", text: `Denied '${action}'.` }],
        structuredContent: {
          approvalId,
          status: "denied",
          action,
        },
      };
    }

    return {
      content: [{ type: "text", text: `Approved and executed '${action}'.` }],
      structuredContent: {
        approvalId,
        status: "approved",
        action,
        executed: true,
      },
    };
  },
);

mcp.registerTool(
  "approval_history",
  {
    description: "Lists in-memory approval decisions for this MCP server process.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ limit }) => {
    const max = limit ?? 20;
    const items = approvals.slice(0, max).map((entry) => ({
      id: entry.id,
      action: entry.action,
      justification: entry.justification,
      decision: entry.decision,
      createdAt: entry.createdAt,
      decidedAt: entry.decidedAt,
    }));

    return {
      content: [{ type: "text", text: `Returning ${items.length} approval entries.` }],
      structuredContent: { items },
    };
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);

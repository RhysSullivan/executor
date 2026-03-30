import { describe, expect, it } from "@effect/vitest";
import { projectCatalogForAgentSdk } from "@executor/ir/catalog";
import type { Source } from "@executor/source-core";

import {
  createMcpCatalogSnapshot,
  type McpCatalogOperationInput,
} from "./catalog";

const createSource = (): Source => ({
  id: "axiom-mcp",
  scopeId: "scope_local",
  name: "Axiom MCP",
  kind: "mcp",
  status: "connected",
  enabled: true,
  namespace: "axiom.mcp",
  createdAt: 0,
  updatedAt: 0,
});

const createDashboardInputSchema = {
  type: "object",
  properties: {
    dashboardJson: {
      type: "string",
    },
  },
  required: ["dashboardJson"],
  additionalProperties: false,
} as const;

const createOperation = (
  input: { outputSchema?: unknown } = {},
): McpCatalogOperationInput => ({
  toolId: "createdashboard",
  title: "createDashboard",
  description: "Create a new dashboard from a JSON document.",
  effect: "write",
  inputSchema: createDashboardInputSchema,
  ...(input.outputSchema !== undefined
    ? { outputSchema: input.outputSchema }
    : {}),
  providerData: {
    toolId: "createdashboard",
    toolName: "createDashboard",
    displayTitle: "createDashboard",
    title: null,
    description: "Create a new dashboard from a JSON document.",
    annotations: null,
    execution: {
      taskSupport: "forbidden",
    },
    icons: null,
    meta: null,
    rawTool: {
      name: "createDashboard",
      description: "Create a new dashboard from a JSON document.",
      inputSchema: createDashboardInputSchema,
      ...(input.outputSchema !== undefined
        ? { outputSchema: input.outputSchema }
        : {}),
    },
    server: null,
  },
});

describe("MCP catalog", () => {
  it("projects missing MCP output schemas as unknown result data", () => {
    const snapshot = createMcpCatalogSnapshot({
      source: createSource(),
      documents: [{
        documentKind: "mcp_manifest",
        documentKey: "https://mcp.axiom.co/mcp",
        contentText: JSON.stringify({ version: 2, tools: [] }),
      }],
      operations: [createOperation()],
    });
    const projected = projectCatalogForAgentSdk({
      catalog: snapshot.catalog,
    });
    const descriptor = Object.values(projected.toolDescriptors).find((entry) =>
      entry.toolPath.join(".") === "axiom.mcp.createdashboard");

    if (!descriptor?.resultShapeId) {
      throw new Error("Expected createdashboard to have a projected result shape");
    }

    const resultShape = projected.catalog.symbols[descriptor.resultShapeId];
    if (resultShape?.kind !== "shape" || resultShape.node.type !== "object") {
      throw new Error("Expected MCP result envelope");
    }

    const dataShape = projected.catalog.symbols[resultShape.node.fields.data.shapeId];
    if (dataShape?.kind !== "shape" || dataShape.node.type !== "anyOf") {
      throw new Error("Expected nullable MCP result data");
    }

    const dataVariants = dataShape.node.items.map((shapeId) => projected.catalog.symbols[shapeId]);
    expect(
      dataVariants.some((shape) => shape?.kind === "shape" && shape.node.type === "unknown"),
    ).toBe(true);
  });

  it("stores lean executable bindings without dropping catalog semantics", () => {
    const snapshot = createMcpCatalogSnapshot({
      source: createSource(),
      documents: [{
        documentKind: "mcp_manifest",
        documentKey: "https://mcp.axiom.co/mcp",
        contentText: JSON.stringify({ version: 2, tools: [] }),
      }],
      operations: [createOperation()],
    });

    const executable = Object.values(snapshot.catalog.executables)[0];
    if (!executable) {
      throw new Error("Expected MCP executable");
    }

    expect(executable.binding).toEqual({
      toolId: "createdashboard",
      toolName: "createDashboard",
    });
    expect(executable.binding).not.toHaveProperty("rawTool");
    expect(executable.display?.title).toBe("createDashboard");

    const capability = snapshot.catalog.capabilities[executable.capabilityId];
    if (!capability) {
      throw new Error("Expected MCP capability");
    }

    expect(capability.surface.title).toBe("createDashboard");
    expect(capability.surface.summary).toBe(
      "Create a new dashboard from a JSON document.",
    );
    expect(capability.interaction.resume.supported).toBe(false);
  });
});

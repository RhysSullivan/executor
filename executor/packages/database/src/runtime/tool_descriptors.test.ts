import { expect, test } from "bun:test";
import type { ToolDefinition } from "../../../core/src/types";
import { listVisibleToolDescriptors } from "./tool_descriptors";

test("listVisibleToolDescriptors derives display hints from schemas", () => {
  const tool: ToolDefinition = {
    path: "github.actions.add_custom_labels_to_self_hosted_runner_for_org",
    description: "Add custom labels",
    approval: "required",
    source: "openapi:github",
    typing: {
      inputSchema: {
        type: "object",
        properties: {
          org: { type: "string" },
          runner_id: { type: "number" },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["org", "runner_id", "labels"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          total_count: { type: "number" },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["total_count", "labels"],
        additionalProperties: true,
      },
    },
    run: async () => ({ total_count: 0, labels: [] }),
  };

  const tools = new Map<string, ToolDefinition>([[tool.path, tool]]);
  const descriptors = listVisibleToolDescriptors(
    tools,
    { workspaceId: "w" },
    [],
    { includeDetails: true },
  );

  expect(descriptors).toHaveLength(1);
  const descriptor = descriptors[0]!;
  expect(descriptor.display?.input).toContain("org");
  expect(descriptor.display?.input).toContain("runner_id");
  expect(descriptor.display?.output).toContain("total_count");
  expect(descriptor.typing?.requiredInputKeys).toEqual(expect.arrayContaining(["org", "runner_id", "labels"]));
  expect(descriptor.typing?.previewInputKeys).toEqual(expect.arrayContaining(["org", "runner_id"]));
});

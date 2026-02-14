import { expect, test } from "bun:test";
import type { ToolDefinition } from "../../core/src/types";
import { listVisibleToolDescriptors } from "./tool_descriptors";

test("listVisibleToolDescriptors formats type hints for client responses", () => {
  const tool: ToolDefinition = {
    path: "github.actions.add_custom_labels_to_self_hosted_runner_for_org",
    description: "Add custom labels",
    approval: "required",
    source: "openapi:github",
    metadata: {
      argsType: '{org:string;runner_id:number;labels:string[]}',
      returnsType: '{total_count:number;labels:components["schemas"]["runner-label"][]}',
      displayArgsType: '{ org: string; runner_id: number; labels: string[] }',
      displayReturnsType: '{ total_count: number; labels: components["schemas"]["runner-label"][] }',
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
  expect(descriptor.argsType).toContain("org: string");
  expect(descriptor.strictArgsType).toContain("runner_id: number");
  expect(descriptor.returnsType).toContain('components["schemas"]["runner-label"][]');
  expect(descriptor.strictReturnsType).toContain("total_count: number");
});

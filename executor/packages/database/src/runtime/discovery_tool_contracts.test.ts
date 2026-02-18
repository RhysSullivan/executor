import { expect, test } from "bun:test";
import { baseTools } from "./base_tools";
import {
  catalogNamespacesInputJsonSchema,
  catalogNamespacesOutputJsonSchema,
  catalogNamespacesOutputSchema,
  catalogToolsInputJsonSchema,
  catalogToolsOutputJsonSchema,
  catalogToolsOutputSchema,
  discoverInputJsonSchema,
  discoverOutputJsonSchema,
  discoverOutputSchema,
} from "./discovery_tool_contracts";

test("base tool discovery schemas use shared contract", () => {
  const namespaces = baseTools.get("catalog.namespaces");
  expect(namespaces?.typing?.inputSchema).toEqual(catalogNamespacesInputJsonSchema);
  expect(namespaces?.typing?.outputSchema).toEqual(catalogNamespacesOutputJsonSchema);

  const tools = baseTools.get("catalog.tools");
  expect(tools?.typing?.inputSchema).toEqual(catalogToolsInputJsonSchema);
  expect(tools?.typing?.outputSchema).toEqual(catalogToolsOutputJsonSchema);

  const discover = baseTools.get("discover");
  expect(discover?.typing?.inputSchema).toEqual(discoverInputJsonSchema);
  expect(discover?.typing?.outputSchema).toEqual(discoverOutputJsonSchema);
});

test("discovery output schemas validate expected payload shape", () => {
  const entry = {
    path: "github.repos.list",
    approval: "auto",
    inputHint: "{ owner: string; repo: string }",
    outputHint: "{ id: number; name: string }",
    typing: {
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
        },
      }),
      outputSchemaJson: JSON.stringify({
        type: "object",
      }),
      previewInputKeys: ["owner", "repo"],
    },
  };

  expect(() => catalogNamespacesOutputSchema.parse({
    namespaces: [{ namespace: "github", toolCount: 1, samplePaths: ["github.repos.list"] }],
    total: 1,
  })).not.toThrow();

  expect(() => catalogToolsOutputSchema.parse({
    results: [entry],
    total: 1,
  })).not.toThrow();

  expect(() => discoverOutputSchema.parse({
    bestPath: "github.repos.list",
    results: [entry],
    total: 1,
  })).not.toThrow();
});

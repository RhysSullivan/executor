import { expect, test } from "bun:test";
import { parseCompiledToolSourceArtifact } from "./tool_source_artifact";

test("parseCompiledToolSourceArtifact accepts JSON string payloads", () => {
  const artifactJson = JSON.stringify({
    version: "v1",
    sourceType: "mcp",
    sourceName: "axiom",
    tools: [
      {
        path: "axiom.search",
        description: "Search docs",
        approval: "auto",
        runSpec: {
          kind: "builtin",
        },
        typing: {
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
          },
        },
      },
    ],
  });

  const parsed = parseCompiledToolSourceArtifact(artifactJson);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isOk()) {
    expect(parsed.value.sourceName).toBe("axiom");
    expect(parsed.value.tools[0]?.typing?.inputSchema?.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  }
});

test("parseCompiledToolSourceArtifact returns error for invalid JSON string", () => {
  const parsed = parseCompiledToolSourceArtifact("{not json");
  expect(parsed.isErr()).toBe(true);
  if (parsed.isErr()) {
    expect(parsed.error.message).toContain("Invalid compiled tool source artifact JSON");
  }
});

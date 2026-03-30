import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { McpExecutableBindingSchema } from "./executable-binding";

describe("MCP executable binding", () => {
  it("accepts legacy verbose bindings and strips manifest-only metadata", () => {
    const decode = Schema.decodeUnknownSync(McpExecutableBindingSchema);

    expect(
      decode({
        toolId: "read_file",
        toolName: "Read File",
        displayTitle: "Read File",
        title: "Read File",
        description: "Read a file",
        annotations: {
          readOnlyHint: true,
        },
        execution: {
          taskSupport: "optional",
        },
        icons: [{
          src: "https://example.test/icon.png",
        }],
        meta: {
          category: "filesystem",
        },
        rawTool: {
          name: "Read File",
        },
        server: {
          info: {
            name: "mcp-server",
            version: "1.0.0",
          },
        },
      }),
    ).toEqual({
      toolId: "read_file",
      toolName: "Read File",
    });
  });
});

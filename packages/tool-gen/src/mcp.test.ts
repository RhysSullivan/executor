import { describe, test, expect } from "bun:test";
import { walkToolTree, isToolDefinition } from "@openassistant/core";
import { generateMcpTools } from "./mcp.js";

describe("generateMcpTools — AnswerOverflow MCP", () => {
  test("connects and generates tools from AnswerOverflow MCP", async () => {
    const result = await generateMcpTools({
      name: "answeroverflow",
      url: "https://www.answeroverflow.com/mcp",
    });

    try {
      // Should produce a tool tree under "answeroverflow"
      expect(result.tools["answeroverflow"]).toBeDefined();

      // Collect all tool paths
      const paths: string[] = [];
      walkToolTree(result.tools, (path) => paths.push(path));

      // AnswerOverflow has 4 known tools
      expect(paths.length).toBe(4);
      expect(paths).toContain("answeroverflow.search_answeroverflow");
      expect(paths).toContain("answeroverflow.search_servers");
      expect(paths).toContain("answeroverflow.get_thread_messages");
      expect(paths).toContain("answeroverflow.find_similar_threads");

      // Each tool should be a valid ToolDefinition
      walkToolTree(result.tools, (_path, tool) => {
        expect(isToolDefinition(tool)).toBe(true);
        expect(tool.description).toBeDefined();
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.approval).toBe("auto"); // default
        expect(typeof tool.formatApproval).toBe("function");
      });

      // TypeScript declarations should be generated
      expect(result.typeDeclaration).toContain("answeroverflow:");
      expect(result.typeDeclaration).toContain("search_answeroverflow");
      expect(result.typeDeclaration).toContain("query: string");

      // Prompt guidance should be generated
      expect(result.promptGuidance).toContain("tools.answeroverflow.search_answeroverflow");
    } finally {
      await result.close();
    }
  }, { timeout: 30_000 });

  test("respects approval overrides", async () => {
    const result = await generateMcpTools({
      name: "answeroverflow",
      url: "https://www.answeroverflow.com/mcp",
      overrides: {
        search_answeroverflow: { approval: "required" },
      },
    });

    try {
      let found = false;
      walkToolTree(result.tools, (path, tool) => {
        if (path === "answeroverflow.search_answeroverflow") {
          expect(tool.approval).toBe("required");
          found = true;
        }
      });
      expect(found).toBe(true);
    } finally {
      await result.close();
    }
  }, { timeout: 30_000 });

  test("generated tools can actually call the MCP server", async () => {
    const result = await generateMcpTools({
      name: "answeroverflow",
      url: "https://www.answeroverflow.com/mcp",
    });

    try {
      // Find the search tool
      let searchTool: ReturnType<typeof isToolDefinition extends (v: unknown) => v is infer T ? () => T : never> | undefined;
      walkToolTree(result.tools, (path, tool) => {
        if (path === "answeroverflow.search_servers") {
          searchTool = tool;
        }
      });

      expect(searchTool).toBeDefined();

      // Actually call the MCP tool
      const searchResult = await searchTool!.run({ query: "discord" });
      expect(searchResult).toBeDefined();
    } finally {
      await result.close();
    }
  }, { timeout: 30_000 });

  test("generated tools include approval preview formatter", async () => {
    const result = await generateMcpTools({
      name: "answeroverflow",
      url: "https://www.answeroverflow.com/mcp",
      overrides: {
        search_servers: { approval: "required" },
      },
    });

    try {
      let foundPreview = false;
      walkToolTree(result.tools, (path, tool) => {
        if (path === "answeroverflow.search_servers") {
          const preview = tool.formatApproval?.({ query: "bun" });
          expect(preview).toBeDefined();
          expect(preview?.title).toBe("Run search_servers");
          expect(preview?.details).toContain("query");
          foundPreview = true;
        }
      });
      expect(foundPreview).toBe(true);
    } finally {
      await result.close();
    }
  }, { timeout: 30_000 });
});

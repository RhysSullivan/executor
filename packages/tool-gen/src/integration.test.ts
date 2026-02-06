/**
 * Integration test: MCP tools → runner sandbox execution.
 *
 * Generates tools from a real MCP server, wires them into the runner,
 * and executes code in the sandbox that calls the MCP tools.
 */

import { describe, test, expect } from "bun:test";
import {
  createRunner,
  generateToolDeclarations,
  typecheckCode,
} from "@openassistant/core";
import { generateMcpTools } from "./mcp.js";

describe("MCP → runner integration", () => {
  test("generated MCP tools are callable from the sandbox", async () => {
    // 1. Generate tools from the real AnswerOverflow MCP server
    const mcpResult = await generateMcpTools({
      name: "answeroverflow",
      url: "https://www.answeroverflow.com/mcp",
    });

    try {
      // 2. Create a runner with the generated tools
      const runner = createRunner({
        tools: mcpResult.tools,
        requestApproval: async () => "approved",
        timeoutMs: 15_000,
      });

      // 3. Execute code in the sandbox that calls the MCP tool
      const result = await runner.run(
        `const servers = await tools.answeroverflow.search_servers({ query: "discord" });\nreturn servers;`,
      );

      // 4. Verify it worked
      expect(result.ok).toBe(true);
      expect(result.value).toBeDefined();
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]!.toolPath).toBe("answeroverflow.search_servers");
      expect(result.receipts[0]!.status).toBe("succeeded");
      expect(result.receipts[0]!.decision).toBe("auto");
    } finally {
      await mcpResult.close();
    }
  }, { timeout: 30_000 });

  test("generated type declarations pass the typechecker", async () => {
    const mcpResult = await generateMcpTools({
      name: "answeroverflow",
      url: "https://www.answeroverflow.com/mcp",
    });

    try {
      // Generate full declarations from the tool tree
      const declarations = generateToolDeclarations(mcpResult.tools);

      // Valid code should pass
      const validResult = typecheckCode(
        `const servers = await tools.answeroverflow.search_servers({ query: "test" });\nreturn servers;`,
        declarations,
      );
      expect(validResult.ok).toBe(true);

      // Invalid tool name should fail
      const invalidResult = typecheckCode(
        `const r = await tools.answeroverflow.nonexistent_tool({ query: "test" });`,
        declarations,
      );
      expect(invalidResult.ok).toBe(false);
    } finally {
      await mcpResult.close();
    }
  }, { timeout: 30_000 });

  test("chained MCP calls work in the sandbox", async () => {
    const mcpResult = await generateMcpTools({
      name: "answeroverflow",
      url: "https://www.answeroverflow.com/mcp",
    });

    try {
      const runner = createRunner({
        tools: mcpResult.tools,
        requestApproval: async () => "approved",
        timeoutMs: 20_000,
      });

      // Chain two MCP calls — search for servers, then search content
      const result = await runner.run(`
        const searchResult = await tools.answeroverflow.search_answeroverflow({ query: "react hooks" });
        const servers = await tools.answeroverflow.search_servers({ query: "javascript" });
        return { searchResult: typeof searchResult, servers: typeof servers };
      `);

      expect(result.ok).toBe(true);
      expect(result.receipts).toHaveLength(2);
      expect(result.receipts[0]!.toolPath).toBe("answeroverflow.search_answeroverflow");
      expect(result.receipts[1]!.toolPath).toBe("answeroverflow.search_servers");
    } finally {
      await mcpResult.close();
    }
  }, { timeout: 30_000 });
});

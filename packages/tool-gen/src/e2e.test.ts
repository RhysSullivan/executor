/**
 * End-to-end test: Real Claude → generates code → typechecks → runs in sandbox → calls real MCP tools.
 *
 * This test uses:
 * - pi-ai with Claude (via ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY)
 * - MCP tools from AnswerOverflow
 * - The full agent loop: prompt → Claude → run_code → typecheck → sandbox → receipts → response
 *
 * Requires: ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY env var to be set.
 */

import { describe, test, expect } from "bun:test";
import { createAgent, createPiAiModel, type TaskEvent } from "@openassistant/core";
import { generateMcpTools } from "./mcp.js";

/**
 * Resolve an Anthropic API key from (in priority order):
 * 1. ANTHROPIC_OAUTH_TOKEN env var
 * 2. ANTHROPIC_API_KEY env var
 * 3. Claude Code's credential file (~/.claude/.credentials.json)
 */
function getAnthropicApiKey(): string | undefined {
  if (process.env["ANTHROPIC_OAUTH_TOKEN"]) return process.env["ANTHROPIC_OAUTH_TOKEN"];
  if (process.env["ANTHROPIC_API_KEY"]) return process.env["ANTHROPIC_API_KEY"];

  // Try Claude Code's credential store
  try {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
    const text = require("fs").readFileSync(`${home}/.claude/.credentials.json`, "utf-8");
    const creds = JSON.parse(text);
    const token = creds?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.startsWith("sk-ant-")) {
      return token;
    }
  } catch {
    // No credentials file
  }

  return undefined;
}

const apiKey = getAnthropicApiKey();
const hasApiKey = !!apiKey;

describe.skipIf(!hasApiKey)("e2e — Claude + MCP + sandbox", () => {
  test("agent generates code to search AnswerOverflow and returns results", async () => {
    // 1. Generate tools from AnswerOverflow MCP
    const mcpResult = await generateMcpTools({
      name: "answeroverflow",
      url: "https://www.answeroverflow.com/mcp",
    });

    try {
      // 2. Create real Claude model via pi-ai
      const model = createPiAiModel({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        apiKey,
      });

      // 3. Collect events
      const events: TaskEvent[] = [];

      // 4. Create agent with real tools + real model
      const agent = createAgent({
        tools: mcpResult.tools,
        model,
        requestApproval: async () => "approved",
        onEvent: (e) => events.push(e),
        maxCodeRuns: 3,
        timeoutMs: 20_000,
      });

      // 5. Run a real prompt
      const result = await agent.run(
        "Search AnswerOverflow for 'react hooks' and tell me how many results you found.",
      );

      // 6. Verify the agent actually ran code
      expect(result.runs.length).toBeGreaterThan(0);
      expect(result.runs[0]!.result.ok).toBe(true);

      // 7. Verify MCP tool was called
      expect(result.allReceipts.length).toBeGreaterThan(0);
      const mcpReceipt = result.allReceipts.find(
        (r) => r.toolPath === "answeroverflow.search_answeroverflow",
      );
      expect(mcpReceipt).toBeDefined();
      expect(mcpReceipt!.status).toBe("succeeded");

      // 8. Verify Claude produced a final text response
      expect(result.text).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);

      // 9. Verify events were emitted
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("status");
      expect(eventTypes).toContain("code_generated");
      expect(eventTypes).toContain("tool_result");
      expect(eventTypes).toContain("agent_message");
      expect(eventTypes).toContain("completed");

      console.log("Agent response:", result.text);
      console.log("Receipts:", result.allReceipts.map((r) => `${r.toolPath}: ${r.status}`));
    } finally {
      await mcpResult.close();
    }
  }, { timeout: 60_000 });
});

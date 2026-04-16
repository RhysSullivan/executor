import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const cliEntry = resolve(repoRoot, "apps/cli/src/main.ts");
const testScope = resolve(repoRoot, "apps/local");

describe("MCP stdio integration", () => {
  it("execute tool returns result over stdio transport", async () => {
    // Fresh temp dir so the test doesn't migrate against the developer's
    // real ~/.executor/data.db.
    const dataDir = mkdtempSync(join(tmpdir(), "executor-mcp-test-"));

    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", cliEntry, "mcp", "--scope", testScope],
      env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
    });

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("execute");

      const result = await client.callTool({
        name: "execute",
        arguments: { code: "return 2+2" },
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      expect(text).toContain("4");
      expect(result.isError).toBeFalsy();
    } finally {
      await transport.close();
    }
  }, 30_000);
});

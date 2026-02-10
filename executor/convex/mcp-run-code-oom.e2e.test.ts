import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { internal } from "./_generated/api";
import schema from "./schema";

const OOM_MESSAGE = "JavaScript execution ran out of memory (maximum memory usage: 64 MB): request stream size was 0 bytes";

function setup() {
  return convexTest(schema, {
    "./database.ts": () => import("./database"),
    "./executor.ts": () => import("./executor"),
    "./executorNode.ts": () => import("./test-fixtures/executorNode.oomFixture"),
    "./http.ts": () => import("./http"),
    "./auth.ts": () => import("./auth"),
    "./workspaceAuthInternal.ts": () => import("./workspaceAuthInternal"),
    "./workspaceToolCache.ts": () => import("./workspaceToolCache"),
    "./openApiSpecCache.ts": () => import("./openApiSpecCache"),
    "./mcpNode.ts": () => import("./mcpNode"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });
}

function createMcpTransport(
  t: ReturnType<typeof setup>,
  workspaceId: string,
  sessionId: string,
  clientId = "oom-repro",
) {
  const url = new URL("https://executor.test/mcp");
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("clientId", clientId);

  return new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const parsed = new URL(raw);
      const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return await t.fetch(path, init);
    },
  });
}

test("MCP run_code reproduces Convex OOM failure surface", async () => {
  const t = setup();
  const session = await t.mutation(internal.database.bootstrapAnonymousSession, {});

  const client = new Client({ name: "executor-oom-repro", version: "0.0.1" }, { capabilities: {} });
  const transport = createMcpTransport(t, session.workspaceId, session.sessionId);

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: "run_code",
      arguments: {
        code: "return await tools.github.users.get_authenticated();",
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized.includes(OOM_MESSAGE)).toBe(true);
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}, 30_000);

import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { internal } from "../../_generated/api";
import schema from "../../schema";

const OOM_MESSAGE = "JavaScript execution ran out of memory (maximum memory usage: 64 MB): request stream size was 0 bytes";

function setup() {
  return convexTest(schema, {
    "../../database.ts": () => import("../../database"),
    "../../executor.ts": () => import("../../executor"),
    "../../executorNode.ts": () => import("../../../src/test-fixtures/executorNode.oomFixture"),
    "../../http.ts": () => import("../../http"),
    "../../auth.ts": () => import("../../auth"),
    "../../workspaceAuthInternal.ts": () => import("../../workspaceAuthInternal"),
    "../../workspaceToolCache.ts": () => import("../../workspaceToolCache"),
    "../../toolRegistry.ts": () => import("../../toolRegistry"),
    "../../openApiSpecCache.ts": () => import("../../openApiSpecCache"),
    "../../_generated/api.js": () => import("../../_generated/api.js"),
  });
}

async function getAnonymousAccessToken(
  t: ReturnType<typeof setup>,
  actorId: string,
): Promise<string | null> {
  const resp = await t.fetch(`/auth/anonymous/token?actorId=${encodeURIComponent(actorId)}`);
  const body = await resp.json().catch(() => ({} as Record<string, unknown>));
  if (resp.status === 503) {
    const msg = typeof (body as any).error === "string" ? (body as any).error : "";
    if (msg.toLowerCase().includes("not configured")) {
      return null;
    }
  }
  if (!resp.ok) {
    const msg = typeof (body as any).error === "string" ? (body as any).error : `HTTP ${resp.status}`;
    throw new Error(`Failed to issue anonymous token: ${msg}`);
  }
  const token = (body as any).accessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Anonymous token response missing accessToken");
  }
  return token;
}

async function createMcpTransport(
  t: ReturnType<typeof setup>,
  workspaceId: string,
  actorId: string,
  sessionId: string,
  clientId = "oom-repro",
) {
  const isAnonymousSession = sessionId.startsWith("anon_session_") || sessionId.startsWith("mcp_");
  const mcpPath = isAnonymousSession ? "/mcp/anonymous" : "/mcp";
  const url = new URL(`https://executor.test${mcpPath}`);
  url.searchParams.set("workspaceId", workspaceId);
  if (!isAnonymousSession) {
    url.searchParams.set("sessionId", sessionId);
  }
  url.searchParams.set("clientId", clientId);

  const anonymousToken = isAnonymousSession ? await getAnonymousAccessToken(t, actorId) : null;
  if (isAnonymousSession && !anonymousToken) {
    // Legacy fallback for local/test when anonymous auth isn't configured.
    url.searchParams.set("actorId", actorId);
  }

  return new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const parsed = new URL(raw);
      const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      const headers = new Headers(init?.headers ?? {});
      if (anonymousToken) {
        headers.set("authorization", `Bearer ${anonymousToken}`);
      }
      return await t.fetch(path, { ...init, headers });
    },
  });
}

test("MCP run_code no longer hits typecheck OOM path", async () => {
  const t = setup();
  const session = await t.mutation(internal.database.bootstrapAnonymousSession, {});

  const client = new Client({ name: "executor-oom-repro", version: "0.0.1" }, { capabilities: {} });
  const transport = await createMcpTransport(t, session.workspaceId, session.actorId, session.sessionId);

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: "run_code",
      arguments: {
        code: "return await tools.github.users.get_authenticated();",
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized.includes(OOM_MESSAGE)).toBe(false);
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}, 30_000);

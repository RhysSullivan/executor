import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { convexTest } from "convex-test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { internal } from "../../_generated/api";
import schema from "../../schema";

const OOM_MESSAGE = "JavaScript execution ran out of memory (maximum memory usage: 64 MB): request stream size was 0 bytes";

function ensureAnonymousAuthKeysConfigured() {
  if (process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM && process.env.ANONYMOUS_AUTH_PUBLIC_KEY_PEM) {
    return;
  }

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.ANONYMOUS_AUTH_PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
}

ensureAnonymousAuthKeysConfigured();

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

type AnonymousTokenResponse = {
  error?: unknown;
  accessToken?: unknown;
};

function readErrorMessage(body: AnonymousTokenResponse): string {
  return typeof body.error === "string" ? body.error : "";
}

function readAccessToken(body: AnonymousTokenResponse): string | null {
  return typeof body.accessToken === "string" && body.accessToken.length > 0 ? body.accessToken : null;
}

async function getAnonymousAccessToken(
  t: ReturnType<typeof setup>,
  accountId: string,
): Promise<string> {
  const resp = await t.fetch(`/auth/anonymous/token?accountId=${encodeURIComponent(accountId)}`);
  const body = await resp.json().catch(() => ({} as AnonymousTokenResponse)) as AnonymousTokenResponse;

  if (!resp.ok) {
    const message = readErrorMessage(body) || `HTTP ${resp.status}`;
    throw new Error(`Failed to issue anonymous token: ${message}`);
  }

  const token = readAccessToken(body);
  if (!token) {
    throw new Error("Anonymous token response missing accessToken");
  }

  return token;
}

async function createMcpTransport(
  t: ReturnType<typeof setup>,
  workspaceId: string,
  accountId: string,
  sessionId: string,
  clientId = "oom-repro",
) {
  const isAnonymousSession = sessionId.startsWith("anon_session_") || sessionId.startsWith("mcp_");
  const url = new URL(`https://executor.test${isAnonymousSession ? "/mcp/anonymous" : "/mcp"}`);
  url.searchParams.set("workspaceId", workspaceId);
  if (!isAnonymousSession) {
    url.searchParams.set("sessionId", sessionId);
  }
  url.searchParams.set("clientId", clientId);

  const anonymousToken = isAnonymousSession
    ? await getAnonymousAccessToken(t, accountId)
    : null;

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
  const transport = await createMcpTransport(t, session.workspaceId, session.accountId, session.sessionId);

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

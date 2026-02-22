import { afterEach, expect, test } from "bun:test";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { issueMcpApiKey, verifyMcpApiKey } from "./mcp_api_key";

const originalMcpApiKeySecret = process.env.MCP_API_KEY_SECRET;
const originalMcpApiKeyTtl = process.env.MCP_API_KEY_TTL_SECONDS;
const originalAnonymousPrivateKey = process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM;

afterEach(() => {
  process.env.MCP_API_KEY_SECRET = originalMcpApiKeySecret;
  process.env.MCP_API_KEY_TTL_SECONDS = originalMcpApiKeyTtl;
  process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM = originalAnonymousPrivateKey;
});

test("issueMcpApiKey + verifyMcpApiKey round trip", async () => {
  process.env.MCP_API_KEY_SECRET = "test-secret";

  const apiKey = await issueMcpApiKey({
    workspaceId: "workspace_123" as Id<"workspaces">,
    accountId: "account_456" as Id<"accounts">,
  });

  expect(apiKey).toBeTruthy();
  const verified = await verifyMcpApiKey(apiKey);
  expect(verified).not.toBeNull();
  expect(verified?.workspaceId).toBe("workspace_123" as Id<"workspaces">);
  expect(verified?.accountId).toBe("account_456" as Id<"accounts">);
});

test("verifyMcpApiKey rejects tampered token", async () => {
  process.env.MCP_API_KEY_SECRET = "test-secret";

  const apiKey = await issueMcpApiKey({
    workspaceId: "workspace_abc" as Id<"workspaces">,
    accountId: "account_xyz" as Id<"accounts">,
  });

  expect(apiKey).toBeTruthy();
  const tampered = `${apiKey}a`;
  const verified = await verifyMcpApiKey(tampered);
  expect(verified).toBeNull();
});

test("issueMcpApiKey returns null when secret is missing", async () => {
  delete process.env.MCP_API_KEY_SECRET;
  delete process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM;

  const apiKey = await issueMcpApiKey({
    workspaceId: "workspace_789" as Id<"workspaces">,
    accountId: "account_987" as Id<"accounts">,
  });

  expect(apiKey).toBeNull();
});

test("does not fall back to anonymous private key", async () => {
  delete process.env.MCP_API_KEY_SECRET;
  process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM = "unused-anonymous-key";

  const apiKey = await issueMcpApiKey({
    workspaceId: "workspace_no_fallback" as Id<"workspaces">,
    accountId: "account_no_fallback" as Id<"accounts">,
  });

  expect(apiKey).toBeNull();
});

test("verifyMcpApiKey rejects expired token", async () => {
  process.env.MCP_API_KEY_SECRET = "test-secret";
  process.env.MCP_API_KEY_TTL_SECONDS = "1";

  const apiKey = await issueMcpApiKey({
    workspaceId: "workspace_expired" as Id<"workspaces">,
    accountId: "account_expired" as Id<"accounts">,
  });

  expect(apiKey).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const verified = await verifyMcpApiKey(apiKey);
  expect(verified).toBeNull();
});

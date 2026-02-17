import { afterEach, expect, test } from "bun:test";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { issueMcpApiKey, verifyMcpApiKey } from "./mcp_api_key";

const originalMcpApiKeySecret = process.env.MCP_API_KEY_SECRET;
const originalAnonymousPrivateKey = process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM;

afterEach(() => {
  process.env.MCP_API_KEY_SECRET = originalMcpApiKeySecret;
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
  expect(verified).toEqual({
    workspaceId: "workspace_123",
    accountId: "account_456",
  });
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

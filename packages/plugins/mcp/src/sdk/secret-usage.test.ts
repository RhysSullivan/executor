import { describe, expect, it } from "vitest";

import type { McpStoredSource } from "./binding-store";
import { collectMcpSecretIds } from "./secret-usage";

describe("collectMcpSecretIds", () => {
  it("collects header auth secret ids for remote sources", () => {
    const source: McpStoredSource = {
      namespace: "remote",
      scope: "org_test",
      name: "Remote MCP",
      config: {
        transport: "remote",
        endpoint: "https://mcp.example.com",
        remoteTransport: "auto",
        auth: {
          kind: "header",
          headerName: "Authorization",
          secretId: "remote_header_secret",
          prefix: "Bearer ",
        },
      },
    };

    expect(collectMcpSecretIds(source)).toEqual(["remote_header_secret"]);
  });

  it("collects oauth2 secret ids for remote sources", () => {
    const source: McpStoredSource = {
      namespace: "oauth",
      scope: "org_test",
      name: "OAuth MCP",
      config: {
        transport: "remote",
        endpoint: "https://mcp.example.com",
        remoteTransport: "auto",
        auth: {
          kind: "oauth2",
          accessTokenSecretId: "access_token_secret",
          refreshTokenSecretId: "refresh_token_secret",
          tokenType: "Bearer",
          expiresAt: null,
          scope: null,
        },
      },
    };

    expect(collectMcpSecretIds(source)).toEqual([
      "access_token_secret",
      "refresh_token_secret",
    ]);
  });

  it("ignores stdio sources", () => {
    const source: McpStoredSource = {
      namespace: "stdio",
      scope: "org_test",
      name: "Local MCP",
      config: {
        transport: "stdio",
        command: "node",
      },
    };

    expect(collectMcpSecretIds(source)).toEqual([]);
  });
});

export type McpInstallConfig = {
  type: "command";
  description: string;
  content: string;
};

export function getAddMcpInstallConfig(
  mcpUrl: string,
  serverName: string,
  auth?: {
    apiKey?: string;
  },
): McpInstallConfig {
  const headerArg = auth
    ? ` --header "x-api-key: ${auth.apiKey}"`
    : "";

  return {
    type: "command",
    description: "Run once to install for all supported clients (via add-mcp):",
    content: auth
      ? `npx add-mcp "${mcpUrl}" --transport http --name "${serverName}" ${headerArg}`
      : `npx add-mcp "${mcpUrl}" --transport http --name "${serverName}" ${headerArg}`,
  };
}

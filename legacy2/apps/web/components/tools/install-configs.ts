export type McpInstallConfig = {
  type: "command";
  description: string;
  content: string;
};

export function getAddMcpInstallConfig(
  mcpUrl: string,
  serverName: string,
): McpInstallConfig {
  return {
    type: "command",
    description: "Run once to install for all supported clients (via add-mcp):",
    content: `npx add-mcp "${mcpUrl}" --transport http --name "${serverName}"`,
  };
}

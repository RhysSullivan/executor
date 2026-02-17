export type McpInstallConfig = {
  type: "command";
  description: string;
  content: string;
};

export function getAddMcpInstallConfig(
  mcpUrl: string,
  serverName: string,
  auth?: {
    apiKeyEnvName?: string;
  },
): McpInstallConfig {
  const apiKeyEnvName = auth?.apiKeyEnvName?.trim() || "API_KEY";
  const headerArg = auth
    ? ` --header "x-api-key: $${apiKeyEnvName}"`
    : "";
  const exportLine = auth
    ? `${apiKeyEnvName}="<paste-api-key-from-above>"`
    : "";

  return {
    type: "command",
    description: "Run once to install for all supported clients (via add-mcp):",
    content: auth
      ? `${exportLine}\nnpx add-mcp "${mcpUrl}" --transport http --name "${serverName}" --all${headerArg}`
      : `npx add-mcp "${mcpUrl}" --transport http --name "${serverName}" --all${headerArg}`,
  };
}

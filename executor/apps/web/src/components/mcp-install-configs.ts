export type McpProviderConfig = {
  id: string;
  name: string;
  icon: string;
  getConfig: (
    mcpUrl: string,
    serverName: string,
  ) => {
    type: "command" | "json" | "toml";
    description: string;
    content: string;
  };
};

export const MCP_PROVIDERS: McpProviderConfig[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    icon: "https://claude.ai/favicon.ico",
    getConfig: (mcpUrl, serverName) => ({
      type: "command",
      description: "Run this command in your terminal:",
      content: `claude mcp add --transport http ${serverName} ${mcpUrl}`,
    }),
  },
  {
    id: "cursor",
    name: "Cursor",
    icon: "https://cursor.com/favicon.ico",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description: "Add to ~/.cursor/mcp.json:",
      content: JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              url: mcpUrl,
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "vscode",
    name: "VS Code",
    icon: "https://code.visualstudio.com/assets/favicon.ico",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description: "Add to VS Code settings (MCP extension):",
      content: JSON.stringify(
        {
          mcp: {
            servers: {
              [serverName]: {
                type: "http",
                url: mcpUrl,
              },
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    icon: "https://windsurf.com/favicon.png",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description: "Add to your Windsurf MCP config file:",
      content: JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              serverUrl: mcpUrl,
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    icon: "https://claude.ai/favicon.ico",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description:
        "Open Claude Desktop Settings > Connectors > Add Custom Connector, or add to ~/Library/Application Support/Claude/claude_desktop_config.json:",
      content: JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              command: "npx",
              args: ["-y", "mcp-remote", mcpUrl],
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "opencode",
    name: "OpenCode",
    icon: "https://opencode.ai/favicon-96x96.png",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description: "Add to your OpenCode config (opencode.json):",
      content: JSON.stringify(
        {
          mcp: {
            [serverName]: {
              type: "remote",
              url: mcpUrl,
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "cline",
    name: "Cline",
    icon: "https://saoudrizwan.gallerycdn.vsassets.io/extensions/saoudrizwan/claude-dev/3.46.1/1766441409033/Microsoft.VisualStudio.Services.Icons.Default",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description:
        "Open Cline > MCP Servers > Remote Servers > Edit Configuration:",
      content: JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              url: mcpUrl,
              type: "streamableHttp",
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "amp",
    name: "Amp",
    icon: "https://ampcode.com/app-icon.png",
    getConfig: (mcpUrl, serverName) => ({
      type: "command",
      description: "Run this command in your terminal:",
      content: `amp mcp add ${serverName} ${mcpUrl}`,
    }),
  },
  {
    id: "zed",
    name: "Zed",
    icon: "https://zed.dev/favicon_black_32.png",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description: "Add to your Zed settings.json:",
      content: JSON.stringify(
        {
          context_servers: {
            [serverName]: {
              source: "custom",
              command: "npx",
              args: ["-y", "mcp-remote", mcpUrl],
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "roo-code",
    name: "Roo Code",
    icon: "https://rooveterinaryinc.gallerycdn.vsassets.io/extensions/rooveterinaryinc/roo-cline/3.37.1/1766531704474/Microsoft.VisualStudio.Services.Icons.Default",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description: "Add to your Roo Code MCP configuration file:",
      content: JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              type: "streamable-http",
              url: mcpUrl,
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    icon: "https://www.gstatic.com/devrel-devsite/prod/ve08add287a6b4bdf8961ab8a1be50bf551be3816cdd70b7cc934114ff3ad5f10/googledevai/images/favicon-new.png",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description: "Add to ~/.gemini/settings.json:",
      content: JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              httpUrl: mcpUrl,
              headers: {
                Accept: "application/json, text/event-stream",
              },
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "copilot-coding-agent",
    name: "Copilot Coding Agent",
    icon: "https://github.githubassets.com/favicons/favicon.svg",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description:
        "Add to Repository > Settings > Copilot > Coding agent > MCP configuration:",
      content: JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              type: "http",
              url: mcpUrl,
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "jetbrains",
    name: "JetBrains AI Assistant",
    icon: "https://www.jetbrains.com/favicon.ico",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description:
        "Go to Settings > Tools > AI Assistant > Model Context Protocol (MCP), click + Add, select 'As JSON':",
      content: JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              command: "npx",
              args: ["-y", "mcp-remote", mcpUrl],
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    icon: "https://openai.com/favicon.ico",
    getConfig: (mcpUrl, serverName) => ({
      type: "toml",
      description: "Add to your OpenAI Codex MCP configuration:",
      content: `[mcp_servers.${serverName}]\nurl = "${mcpUrl}"`,
    }),
  },
  {
    id: "kilo-code",
    name: "Kilo Code",
    icon: "https://kilo.ai/favicon.ico",
    getConfig: (mcpUrl, serverName) => ({
      type: "json",
      description:
        "Open Settings > MCP Servers > Add Server, or add to .kilocode/mcp.json:",
      content: JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              type: "streamable-http",
              url: mcpUrl,
              disabled: false,
            },
          },
        },
        null,
        2,
      ),
    }),
  },
];

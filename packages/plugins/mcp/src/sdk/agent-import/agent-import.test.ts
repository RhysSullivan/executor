import { describe, expect, it } from "vitest";

import { normalizeAgentConfig } from "./normalize";
import { detectAgentFromFilename, detectAgentFromContent, parseAgentConfigContent } from "./reader";
import type { AgentKey } from "./types";

// ---------------------------------------------------------------------------
// normalizeAgentConfig
// ---------------------------------------------------------------------------

describe("normalizeAgentConfig — standard agents (mcpServers)", () => {
  const stdioConfig = {
    mcpServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { DEBUG: "1" },
      },
    },
  };

  const remoteConfig = {
    mcpServers: {
      context7: {
        url: "https://mcp.context7.com/mcp",
        type: "http",
        headers: { Authorization: "Bearer tok" },
      },
    },
  };

  for (const agent of [
    "claude-code",
    "claude-desktop",
    "amp",
    "cursor",
    "cline",
    "cline-cli",
    "gemini-cli",
    "copilot",
    "antigravity",
  ] as AgentKey[]) {
    it(`${agent} — normalizes stdio server`, () => {
      const result = normalizeAgentConfig(agent, stdioConfig);
      expect(result).toHaveLength(1);
      const s = result[0]!;
      expect(s.name).toBe("filesystem");
      expect(s.config.transport).toBe("stdio");
      if (s.config.transport === "stdio") {
        expect(s.config.command).toBe("npx");
        expect(s.config.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
        expect(s.config.env).toEqual({ DEBUG: "1" });
      }
    });

    it(`${agent} — normalizes remote server`, () => {
      const result = normalizeAgentConfig(agent, remoteConfig);
      expect(result).toHaveLength(1);
      const s = result[0]!;
      expect(s.name).toBe("context7");
      expect(s.config.transport).toBe("remote");
      if (s.config.transport === "remote") {
        expect(s.config.endpoint).toBe("https://mcp.context7.com/mcp");
        expect(s.config.headers).toEqual({ Authorization: "Bearer tok" });
        expect(s.config.remoteTransport).toBe("streamable-http");
      }
    });
  }
});

describe("normalizeAgentConfig — opencode", () => {
  it("normalizes remote server", () => {
    const config = {
      mcp: {
        context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
      },
    };
    const result = normalizeAgentConfig("opencode", config);
    expect(result).toHaveLength(1);
    const s = result[0]!;
    expect(s.config.transport).toBe("remote");
    if (s.config.transport === "remote") {
      expect(s.config.endpoint).toBe("https://mcp.context7.com/mcp");
    }
  });

  it("normalizes stdio server with array command", () => {
    const config = {
      mcp: {
        filesystem: {
          type: "local",
          command: ["node", "/path/to/server.js"],
          enabled: true,
          environment: { HOME: "/home/user" },
        },
      },
    };
    const result = normalizeAgentConfig("opencode", config);
    expect(result).toHaveLength(1);
    const s = result[0]!;
    expect(s.config.transport).toBe("stdio");
    if (s.config.transport === "stdio") {
      expect(s.config.command).toBe("node");
      expect(s.config.args).toEqual(["/path/to/server.js"]);
      expect(s.config.env).toEqual({ HOME: "/home/user" });
    }
  });

  it("normalizes stdio server with string command", () => {
    const config = {
      mcp: {
        myserver: { type: "local", command: "python", args: ["server.py"] },
      },
    };
    const result = normalizeAgentConfig("opencode", config);
    expect(result).toHaveLength(1);
    const s = result[0]!;
    if (s.config.transport === "stdio") {
      expect(s.config.command).toBe("python");
      expect(s.config.args).toEqual(["server.py"]);
    }
  });
});

describe("normalizeAgentConfig — vscode", () => {
  it("uses servers key", () => {
    const config = {
      servers: {
        myserver: { type: "http", url: "https://example.com/mcp" },
      },
    };
    const result = normalizeAgentConfig("vscode", config);
    expect(result).toHaveLength(1);
    expect(result[0]!.config.transport).toBe("remote");
  });
});

describe("normalizeAgentConfig — zed", () => {
  it("uses context_servers key", () => {
    const config = {
      context_servers: {
        myserver: { source: "custom", url: "https://example.com/mcp" },
      },
    };
    const result = normalizeAgentConfig("zed", config);
    expect(result).toHaveLength(1);
    expect(result[0]!.config.transport).toBe("remote");
  });

  it("normalizes stdio", () => {
    const config = {
      context_servers: {
        local: { source: "custom", command: "node", args: ["server.js"] },
      },
    };
    const result = normalizeAgentConfig("zed", config);
    expect(result).toHaveLength(1);
    if (result[0]!.config.transport === "stdio") {
      expect(result[0]!.config.command).toBe("node");
    }
  });
});

describe("normalizeAgentConfig — goose", () => {
  it("normalizes remote (streamable_http)", () => {
    const config = {
      extensions: {
        context7: {
          type: "streamable_http",
          uri: "https://mcp.context7.com/mcp",
          enabled: true,
        },
      },
    };
    const result = normalizeAgentConfig("goose", config);
    expect(result).toHaveLength(1);
    const s = result[0]!;
    expect(s.config.transport).toBe("remote");
    if (s.config.transport === "remote") {
      expect(s.config.endpoint).toBe("https://mcp.context7.com/mcp");
      expect(s.config.remoteTransport).toBe("streamable-http");
    }
  });

  it("normalizes stdio (cmd key)", () => {
    const config = {
      extensions: {
        myserver: {
          type: "stdio",
          cmd: "npx",
          args: ["-y", "some-pkg"],
          envs: { KEY: "val" },
        },
      },
    };
    const result = normalizeAgentConfig("goose", config);
    expect(result).toHaveLength(1);
    if (result[0]!.config.transport === "stdio") {
      expect(result[0]!.config.command).toBe("npx");
      expect(result[0]!.config.env).toEqual({ KEY: "val" });
    }
  });
});

describe("normalizeAgentConfig — codex", () => {
  it("normalizes remote with http_headers", () => {
    const config = {
      mcp_servers: {
        myapi: {
          type: "http",
          url: "https://api.example.com/mcp",
          http_headers: { "X-Key": "secret" },
        },
      },
    };
    const result = normalizeAgentConfig("codex", config);
    expect(result).toHaveLength(1);
    if (result[0]!.config.transport === "remote") {
      expect(result[0]!.config.headers).toEqual({ "X-Key": "secret" });
    }
  });
});

describe("normalizeAgentConfig — edge cases", () => {
  it("returns empty array for empty config", () => {
    expect(normalizeAgentConfig("claude-code", {})).toEqual([]);
  });

  it("returns empty array when servers key missing", () => {
    expect(normalizeAgentConfig("claude-code", { other: {} })).toEqual([]);
  });

  it("skips entries with no command or url", () => {
    const config = { mcpServers: { broken: { unknown: "field" } } };
    expect(normalizeAgentConfig("claude-code", config)).toEqual([]);
  });

  it("handles multiple servers", () => {
    const config = {
      mcpServers: {
        a: { command: "npx", args: ["-y", "pkg-a"] },
        b: { url: "https://b.example.com/mcp" },
        c: { command: "python", args: ["c.py"] },
      },
    };
    const result = normalizeAgentConfig("claude-code", config);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.name)).toEqual(["a", "b", "c"]);
  });

  it("derives namespace from server name", () => {
    const config = { mcpServers: { "My Server": { command: "myserver" } } };
    const result = normalizeAgentConfig("claude-code", config);
    expect(result[0]!.suggestedNamespace).toBe("my_server");
  });
});

// ---------------------------------------------------------------------------
// JSONC comment stripping
// ---------------------------------------------------------------------------

describe("JSONC comment stripping", () => {
  it("strips line comments", () => {
    const jsonc = `{
  // This is a comment
  "key": "value"
}`;
    // We test indirectly via parseAgentConfigContent
    const result = parseAgentConfigContent(jsonc, "test.json", "claude-code");
    expect(result).resolves.toHaveLength(0); // no mcpServers key
  });

  it("strips block comments", () => {
    const jsonc = `{
  /* block comment */
  "mcpServers": {
    "fs": { "command": "node" }
  }
}`;
    return expect(parseAgentConfigContent(jsonc, "test.json", "claude-code")).resolves.toHaveLength(
      1,
    );
  });

  it("strips trailing commas", () => {
    const jsonc = `{
  "mcpServers": {
    "fs": { "command": "node", },
  }
}`;
    return expect(parseAgentConfigContent(jsonc, "test.json", "claude-code")).resolves.toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// detectAgentFromFilename
// ---------------------------------------------------------------------------

describe("detectAgentFromFilename", () => {
  it.each([
    ["opencode.json", "opencode"],
    ["opencode.jsonc", "opencode"],
    [".mcp.json", "claude-code"],
    ["mcp.json", "claude-code"],
    ["claude_desktop_config.json", "claude-desktop"],
    ["cline_mcp_settings.json", "cline"],
    ["config.toml", "codex"],
    ["config.yaml", "goose"],
    ["mcp-config.json", "copilot"],
    ["mcp_config.json", "antigravity"],
    ["mcporter.json", "mcporter"],
    ["mcporter.jsonc", "mcporter"],
    [".claude.json", "claude-code"],
    ["unknown.json", null],
  ])("filename %s → %s", (filename, expected) => {
    expect(detectAgentFromFilename(filename)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// detectAgentFromContent
// ---------------------------------------------------------------------------

describe("detectAgentFromContent", () => {
  it.each([
    [{ mcp: {} }, "opencode"],
    [{ context_servers: {} }, "zed"],
    [{ extensions: {} }, "goose"],
    [{ mcp_servers: {} }, "codex"],
    [{ servers: {} }, "vscode"],
    [{ mcpServers: {} }, "claude-code"],
    [{}, null],
    [null, null],
    ["string", null],
  ])("content %j → %s", (content, expected) => {
    expect(detectAgentFromContent(content)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// parseAgentConfigContent — format detection
// ---------------------------------------------------------------------------

describe("parseAgentConfigContent", () => {
  it("parses opencode.json", async () => {
    const content = JSON.stringify({
      mcp: {
        context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
      },
    });
    const result = await parseAgentConfigContent(content, "opencode.json");
    expect(result).toHaveLength(1);
    expect(result[0]!.config.transport).toBe("remote");
  });

  it("parses .mcp.json as claude-code", async () => {
    const content = JSON.stringify({
      mcpServers: { fs: { command: "npx", args: ["-y", "fs"] } },
    });
    const result = await parseAgentConfigContent(content, ".mcp.json");
    expect(result).toHaveLength(1);
    expect(result[0]!.config.transport).toBe("stdio");
  });

  it("auto-detects agent from content when filename unknown", async () => {
    const content = JSON.stringify({
      context_servers: {
        local: { command: "node", args: ["server.js"] },
      },
    });
    const result = await parseAgentConfigContent(content, "unknown.json");
    expect(result).toHaveLength(1);
    expect(result[0]!.config.transport).toBe("stdio");
  });

  it("returns empty array for empty content", async () => {
    const result = await parseAgentConfigContent("{}", "mcp.json", "claude-code");
    expect(result).toHaveLength(0);
  });

  it("throws AgentImportError on invalid JSON", async () => {
    await expect(
      parseAgentConfigContent("not valid json", "mcp.json", "claude-code"),
    ).rejects.toThrow("Failed to parse config file");
  });

  it("parses goose YAML config", async () => {
    const yaml = `
extensions:
  context7:
    type: streamable_http
    uri: https://mcp.context7.com/mcp
    enabled: true
`;
    const result = await parseAgentConfigContent(yaml, "config.yaml", "goose");
    expect(result).toHaveLength(1);
    if (result[0]!.config.transport === "remote") {
      expect(result[0]!.config.endpoint).toBe("https://mcp.context7.com/mcp");
    }
  });

  it("parses codex TOML config", async () => {
    const toml = `
[mcp_servers.myserver]
command = "npx"
args = ["-y", "some-pkg"]
`;
    const result = await parseAgentConfigContent(toml, "config.toml", "codex");
    expect(result).toHaveLength(1);
    if (result[0]!.config.transport === "stdio") {
      expect(result[0]!.config.command).toBe("npx");
    }
  });
});

// ---------------------------------------------------------------------------
// Remote transport normalization
// ---------------------------------------------------------------------------

describe("remote transport normalization", () => {
  it.each([
    ["sse", "sse"],
    ["streamableHttp", "streamable-http"],
    ["streamable-http", "streamable-http"],
    ["http", "streamable-http"],
    [undefined, "auto"],
    ["unknown", "auto"],
  ] as [string | undefined, string][])("type=%s → remoteTransport=%s", (type, expected) => {
    const config = {
      mcpServers: {
        server: type
          ? { url: "https://example.com/mcp", type }
          : { url: "https://example.com/mcp" },
      },
    };
    const result = normalizeAgentConfig("claude-code", config);
    expect(result[0]!.config.transport).toBe("remote");
    if (result[0]!.config.transport === "remote") {
      expect(result[0]!.config.remoteTransport).toBe(expected);
    }
  });
});

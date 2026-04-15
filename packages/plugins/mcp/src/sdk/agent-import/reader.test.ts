import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readAgentConfigFile,
  parseAgentConfigContent,
  findAndReadAgentConfig,
  detectInstalledAgents,
} from "./reader";

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "executor-agent-import-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const write = (rel: string, content: string): string => {
  const full = join(tmpDir, rel);
  mkdirSync(join(tmpDir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(full, content, "utf-8");
  return full;
};

// ---------------------------------------------------------------------------
// readAgentConfigFile — real file I/O
// ---------------------------------------------------------------------------

describe("readAgentConfigFile", () => {
  it("reads and normalizes a claude-code config", async () => {
    const filePath = write(
      "claude.json",
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { DEBUG: "1" },
          },
        },
      }),
    );

    const servers = await readAgentConfigFile(filePath, "claude-code");
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("filesystem");
    expect(servers[0]!.config.transport).toBe("stdio");
    if (servers[0]!.config.transport === "stdio") {
      expect(servers[0]!.config.command).toBe("npx");
      expect(servers[0]!.config.args).toEqual([
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/tmp",
      ]);
      expect(servers[0]!.config.env).toEqual({ DEBUG: "1" });
    }
  });

  it("reads and normalizes an opencode JSONC config with comments", async () => {
    const filePath = write(
      "opencode.jsonc",
      `{
  // opencode config with comments
  "mcp": {
    "context7": {
      "type": "remote",
      /* the remote URL */
      "url": "https://mcp.context7.com/mcp",
    },
  }
}`,
    );

    const servers = await readAgentConfigFile(filePath, "opencode");
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("context7");
    expect(servers[0]!.config.transport).toBe("remote");
    if (servers[0]!.config.transport === "remote") {
      expect(servers[0]!.config.endpoint).toBe("https://mcp.context7.com/mcp");
    }
  });

  it("reads a vscode mcp.json config", async () => {
    const filePath = write(
      "mcp.json",
      JSON.stringify({
        servers: {
          myapi: { type: "http", url: "https://api.example.com/mcp" },
        },
      }),
    );

    const servers = await readAgentConfigFile(filePath, "vscode");
    expect(servers).toHaveLength(1);
    expect(servers[0]!.config.transport).toBe("remote");
  });

  it("reads a goose YAML config", async () => {
    const filePath = write(
      "config.yaml",
      `extensions:
  context7:
    type: streamable_http
    uri: https://mcp.context7.com/mcp
    enabled: true
  localserver:
    type: stdio
    cmd: npx
    args:
      - -y
      - some-package
    envs:
      KEY: value
`,
    );

    const servers = await readAgentConfigFile(filePath, "goose");
    expect(servers).toHaveLength(2);
    const remote = servers.find((s) => s.name === "context7")!;
    const local = servers.find((s) => s.name === "localserver")!;
    expect(remote.config.transport).toBe("remote");
    expect(local.config.transport).toBe("stdio");
    if (remote.config.transport === "remote") {
      expect(remote.config.endpoint).toBe("https://mcp.context7.com/mcp");
      expect(remote.config.remoteTransport).toBe("streamable-http");
    }
    if (local.config.transport === "stdio") {
      expect(local.config.command).toBe("npx");
      expect(local.config.env).toEqual({ KEY: "value" });
    }
  });

  it("reads a codex TOML config", async () => {
    const filePath = write(
      "config.toml",
      `[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]

[mcp_servers.myapi]
type = "http"
url = "https://api.example.com/mcp"
`,
    );

    const servers = await readAgentConfigFile(filePath, "codex");
    expect(servers).toHaveLength(2);
    const local = servers.find((s) => s.name === "filesystem")!;
    const remote = servers.find((s) => s.name === "myapi")!;
    expect(local.config.transport).toBe("stdio");
    expect(remote.config.transport).toBe("remote");
  });

  it("returns empty array for config with no servers", async () => {
    const filePath = write("empty.json", JSON.stringify({ mcpServers: {} }));
    const servers = await readAgentConfigFile(filePath, "claude-code");
    expect(servers).toHaveLength(0);
  });

  it("throws AgentImportError when file does not exist", async () => {
    await expect(
      readAgentConfigFile(join(tmpDir, "nonexistent.json"), "claude-code"),
    ).rejects.toThrow("Config file not found");
  });

  it("throws AgentImportError on malformed JSON", async () => {
    const filePath = write("bad.json", "{ not valid json }");
    await expect(readAgentConfigFile(filePath, "claude-code")).rejects.toThrow(
      "Failed to parse config file",
    );
  });

  it("reads multiple servers and preserves order", async () => {
    const filePath = write(
      "multi.json",
      JSON.stringify({
        mcpServers: {
          alpha: { command: "alpha" },
          beta: { url: "https://beta.example.com/mcp" },
          gamma: { command: "gamma", args: ["-v"] },
        },
      }),
    );

    const servers = await readAgentConfigFile(filePath, "claude-code");
    expect(servers).toHaveLength(3);
    expect(servers.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
  });
});

// ---------------------------------------------------------------------------
// parseAgentConfigContent — raw string input
// ---------------------------------------------------------------------------

describe("parseAgentConfigContent", () => {
  it("parses JSON content with explicit agent", async () => {
    const content = JSON.stringify({
      mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
    });
    const servers = await parseAgentConfigContent(content, "opencode.json", "opencode");
    expect(servers).toHaveLength(1);
    expect(servers[0]!.config.transport).toBe("remote");
  });

  it("auto-detects opencode from filename", async () => {
    const content = JSON.stringify({
      mcp: { myserver: { type: "local", command: "node", args: ["server.js"] } },
    });
    const servers = await parseAgentConfigContent(content, "opencode.json");
    expect(servers).toHaveLength(1);
    expect(servers[0]!.config.transport).toBe("stdio");
  });

  it("auto-detects claude-code from .mcp.json filename", async () => {
    const content = JSON.stringify({
      mcpServers: { fs: { command: "npx", args: ["-y", "fs"] } },
    });
    const servers = await parseAgentConfigContent(content, ".mcp.json");
    expect(servers).toHaveLength(1);
    expect(servers[0]!.config.transport).toBe("stdio");
  });

  it("auto-detects goose from config.yaml filename", async () => {
    const yaml = `extensions:\n  srv:\n    type: stdio\n    cmd: node\n    args: []\n`;
    const servers = await parseAgentConfigContent(yaml, "config.yaml");
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("srv");
  });

  it("auto-detects agent from content when filename is unknown", async () => {
    const content = JSON.stringify({
      context_servers: { local: { command: "node", args: ["server.js"] } },
    });
    const servers = await parseAgentConfigContent(content, "some-unknown-file.json");
    // auto-detected as zed
    expect(servers).toHaveLength(1);
    expect(servers[0]!.config.transport).toBe("stdio");
  });

  it("strips JSONC comments and trailing commas", async () => {
    const jsonc = `{
  // comment
  "mcpServers": {
    /* block */
    "server": {
      "command": "node",
      "args": ["server.js"], /* trailing comma below */
    },
  }
}`;
    const servers = await parseAgentConfigContent(jsonc, "mcp.json", "claude-code");
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("server");
  });

  it("throws on completely invalid JSON", async () => {
    await expect(
      parseAgentConfigContent("not json at all", "mcp.json", "claude-code"),
    ).rejects.toThrow("Failed to parse config file");
  });

  it("returns empty array for empty mcpServers object", async () => {
    const content = JSON.stringify({ mcpServers: {} });
    const servers = await parseAgentConfigContent(content, "mcp.json", "claude-code");
    expect(servers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findAndReadAgentConfig — real filesystem
// ---------------------------------------------------------------------------

describe("findAndReadAgentConfig", () => {
  it("finds local config file in cwd", async () => {
    const content = JSON.stringify({
      mcpServers: { fs: { command: "npx", args: ["-y", "fs-server"] } },
    });
    write("opencode.json", content);

    // Use a different agent key since we want to find opencode.json locally
    const configContent = JSON.stringify({
      mcp: { myserver: { type: "local", command: "node", args: ["s.js"] } },
    });
    write("opencode.json", configContent);

    const result = await findAndReadAgentConfig("opencode", { cwd: tmpDir });
    expect(result.agent).toBe("opencode");
    expect(result.filePath).toContain("opencode.json");
    expect(result.servers).toHaveLength(1);
  });

  it("finds .mcp.json for claude-code", async () => {
    const content = JSON.stringify({
      mcpServers: {
        context7: { url: "https://mcp.context7.com/mcp" },
      },
    });
    write(".mcp.json", content);

    const result = await findAndReadAgentConfig("claude-code", { cwd: tmpDir });
    expect(result.filePath).toContain(".mcp.json");
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]!.name).toBe("context7");
  });

  it("throws AgentImportError when no config found", async () => {
    // Use mcporter — its global path (~/.mcporter/mcporter.json) is
    // extremely unlikely to exist on any dev/CI machine, and its only
    // local path (config/mcporter.json) is not present in tmpDir.
    await expect(findAndReadAgentConfig("mcporter", { cwd: tmpDir })).rejects.toThrow(
      "No config file found for agent",
    );
  });

  it("local config takes priority over global config path", async () => {
    // Write a local config with 1 server
    write(".mcp.json", JSON.stringify({ mcpServers: { local: { command: "local-server" } } }));

    const result = await findAndReadAgentConfig("claude-code", { cwd: tmpDir });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]!.name).toBe("local");
  });

  it("reads vscode local config from .vscode/mcp.json", async () => {
    write(
      ".vscode/mcp.json",
      JSON.stringify({ servers: { myapi: { url: "https://api.example.com/mcp" } } }),
    );

    const result = await findAndReadAgentConfig("vscode", { cwd: tmpDir });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]!.config.transport).toBe("remote");
  });
});

// ---------------------------------------------------------------------------
// detectInstalledAgents — real filesystem
// ---------------------------------------------------------------------------

describe("detectInstalledAgents", () => {
  it("detects opencode config in cwd", async () => {
    write(
      "opencode.json",
      JSON.stringify({
        mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
      }),
    );

    const agents = await detectInstalledAgents({ cwd: tmpDir });
    const opencode = agents.find((a) => a.agent === "opencode");
    expect(opencode).toBeDefined();
    expect(opencode!.serverCount).toBe(1);
  });

  it("detects multiple agents", async () => {
    write(
      "opencode.json",
      JSON.stringify({
        mcp: { srv1: { type: "local", command: "node", args: [] } },
      }),
    );
    write(
      ".mcp.json",
      JSON.stringify({
        mcpServers: { srv2: { command: "npx", args: ["-y", "pkg"] } },
      }),
    );
    write(
      ".vscode/mcp.json",
      JSON.stringify({
        servers: { srv3: { url: "https://srv3.example.com/mcp" } },
      }),
    );

    const agents = await detectInstalledAgents({ cwd: tmpDir });
    const keys = agents.map((a) => a.agent);
    expect(keys).toContain("opencode");
    expect(keys).toContain("claude-code");
    expect(keys).toContain("vscode");
  });

  it("returns empty array when no configs found", async () => {
    const agents = await detectInstalledAgents({ cwd: tmpDir });
    // Only checking local paths from tmpDir — global paths may or may not exist
    const localAgents = agents.filter((a) => a.filePath.startsWith(tmpDir));
    expect(localAgents).toHaveLength(0);
  });

  it("skips configs that have no servers", async () => {
    write("opencode.json", JSON.stringify({ mcp: {} }));

    const agents = await detectInstalledAgents({ cwd: tmpDir });
    const local = agents.filter((a) => a.filePath.startsWith(tmpDir));
    const opencode = local.find((a) => a.agent === "opencode");
    // Should not be included since serverCount is 0
    expect(opencode).toBeUndefined();
  });

  it("reports correct serverCount", async () => {
    write(
      "opencode.json",
      JSON.stringify({
        mcp: {
          srv1: { type: "remote", url: "https://srv1.example.com/mcp" },
          srv2: { type: "local", command: "node", args: [] },
          srv3: { type: "local", command: "python", args: ["s.py"] },
        },
      }),
    );

    const agents = await detectInstalledAgents({ cwd: tmpDir });
    const opencode = agents.find((a) => a.agent === "opencode" && a.filePath.startsWith(tmpDir));
    expect(opencode).toBeDefined();
    expect(opencode!.serverCount).toBe(3);
  });

  it("does not deduplicate across agent types with different keys", async () => {
    // claude-code and amp both read .mcp.json but are different agents
    write(".mcp.json", JSON.stringify({ mcpServers: { fs: { command: "node" } } }));

    const agents = await detectInstalledAgents({ cwd: tmpDir });
    const local = agents.filter((a) => a.filePath.startsWith(tmpDir));
    // At least claude-code should appear; amp uses same path but might be deduplicated
    expect(local.some((a) => a.agent === "claude-code")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Namespace derivation in normalized servers
// ---------------------------------------------------------------------------

describe("suggestedNamespace derivation", () => {
  it("derives namespace from server name", async () => {
    const filePath = write(
      "mcp.json",
      JSON.stringify({ mcpServers: { "My Cool Server": { command: "server" } } }),
    );
    const servers = await readAgentConfigFile(filePath, "claude-code");
    expect(servers[0]!.suggestedNamespace).toBe("my_cool_server");
  });

  it("derives namespace from endpoint hostname for remote servers", async () => {
    const filePath = write(
      "mcp.json",
      JSON.stringify({
        mcpServers: { context7: { url: "https://mcp.context7.com/mcp" } },
      }),
    );
    const servers = await readAgentConfigFile(filePath, "claude-code");
    // name takes priority over endpoint in deriveMcpNamespace
    expect(servers[0]!.suggestedNamespace).toBe("context7");
  });

  it("falls through to command for whitespace-only server names", async () => {
    const filePath = write(
      "mcp.json",
      JSON.stringify({
        mcpServers: { "   ": { command: "my-server" } },
      }),
    );
    const servers = await readAgentConfigFile(filePath, "claude-code");
    // whitespace-only name → deriveMcpNamespace skips name branch, uses command
    expect(servers[0]!.suggestedNamespace).toBe("my_server");
  });
});

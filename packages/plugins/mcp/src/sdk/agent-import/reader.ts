// ---------------------------------------------------------------------------
// Agent config reader — resolve paths + parse files
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { parse as yamlParse } from "yaml";
import { parse as tomlParse } from "smol-toml";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { AgentKey, ConfigFormat, NormalizedServer } from "./types";
import { AgentImportError } from "./types";
import { normalizeAgentConfig } from "./normalize";

// ---------------------------------------------------------------------------
// Platform environment
// ---------------------------------------------------------------------------

export interface PlatformEnv {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly appData: string; // Windows %APPDATA% or fallback
  readonly xdgConfig: string; // XDG_CONFIG_HOME or fallback
}

export const getCurrentPlatformEnv = (): PlatformEnv => {
  const home = homedir();
  const platform = process.platform;
  const appData =
    platform === "win32"
      ? (process.env.APPDATA ?? join(home, "AppData", "Roaming"))
      : join(home, "Library", "Application Support");
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return { platform, home, appData, xdgConfig };
};

// ---------------------------------------------------------------------------
// Global config paths per agent
// ---------------------------------------------------------------------------

export const getGlobalConfigPaths = (agent: AgentKey, env: PlatformEnv): string[] => {
  const { platform, home, appData, xdgConfig } = env;

  switch (agent) {
    case "opencode":
      return [
        join(xdgConfig, "opencode", "opencode.json"),
        join(xdgConfig, "opencode", "opencode.jsonc"),
      ];

    case "claude-code":
      return [join(home, ".claude.json")];

    case "claude-desktop": {
      if (platform === "win32") return [join(appData, "Claude", "claude_desktop_config.json")];
      if (platform === "darwin")
        return [
          join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        ];
      return [join(xdgConfig, "Claude", "claude_desktop_config.json")];
    }

    case "amp":
      // Claude AMP uses same location as claude-code
      return [join(home, ".claude.json")];

    case "cursor":
      return [join(home, ".cursor", "mcp.json")];

    case "vscode": {
      if (platform === "win32") return [join(appData, "Code", "User", "mcp.json")];
      if (platform === "darwin")
        return [join(home, "Library", "Application Support", "Code", "User", "mcp.json")];
      return [join(xdgConfig, "Code", "User", "mcp.json")];
    }

    case "cline": {
      if (platform === "win32")
        return [
          join(
            appData,
            "Code",
            "User",
            "globalStorage",
            "saoudrizwan.claude-dev",
            "settings",
            "cline_mcp_settings.json",
          ),
        ];
      if (platform === "darwin")
        return [
          join(
            home,
            "Library",
            "Application Support",
            "Code",
            "User",
            "globalStorage",
            "saoudrizwan.claude-dev",
            "settings",
            "cline_mcp_settings.json",
          ),
        ];
      return [
        join(
          xdgConfig,
          "Code",
          "User",
          "globalStorage",
          "saoudrizwan.claude-dev",
          "settings",
          "cline_mcp_settings.json",
        ),
      ];
    }

    case "cline-cli": {
      const clineDir = process.env.CLINE_DIR ?? join(home, ".cline");
      return [join(clineDir, "data", "settings", "cline_mcp_settings.json")];
    }

    case "zed": {
      if (platform === "darwin")
        return [join(home, "Library", "Application Support", "Zed", "settings.json")];
      if (platform === "win32") return [join(appData, "Zed", "settings.json")];
      return [join(xdgConfig, "zed", "settings.json")];
    }

    case "goose": {
      if (platform === "win32") return [join(appData, "Block", "goose", "config", "config.yaml")];
      return [join(xdgConfig, "goose", "config.yaml")];
    }

    case "codex": {
      const codexHome = process.env.CODEX_HOME ?? join(home, ".codex");
      return [join(codexHome, "config.toml")];
    }

    case "gemini-cli":
      return [join(home, ".gemini", "settings.json")];

    case "copilot": {
      const copilotDir = process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME)
        : join(home, ".copilot");
      return [join(copilotDir, "mcp-config.json")];
    }

    case "antigravity":
      return [join(home, ".gemini", "antigravity", "mcp_config.json")];

    case "mcporter": {
      const base = join(home, ".mcporter");
      return [join(base, "mcporter.json"), join(base, "mcporter.jsonc")];
    }
  }
};

// ---------------------------------------------------------------------------
// Local config paths per agent (relative to cwd)
// ---------------------------------------------------------------------------

export const getLocalConfigPaths = (agent: AgentKey): string[] => {
  switch (agent) {
    case "opencode":
      return ["opencode.json", "opencode.jsonc"];
    case "claude-code":
    case "amp":
      return [".mcp.json"];
    case "cursor":
      return [".cursor/mcp.json"];
    case "vscode":
    case "copilot":
      return [".vscode/mcp.json"];
    case "cline":
    case "cline-cli":
      return [];
    case "zed":
      return [".zed/settings.json"];
    case "codex":
      return [".codex/config.toml"];
    case "gemini-cli":
      return [".gemini/settings.json"];
    case "mcporter":
      return ["config/mcporter.json", "config/mcporter.jsonc"];
    default:
      return [];
  }
};

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export const detectFormat = (filePath: string, agent: AgentKey): ConfigFormat => {
  // Filename extension takes priority — allows drag-dropping non-default formats
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) return "yaml";
  if (filePath.endsWith(".toml")) return "toml";
  if (filePath.endsWith(".json") || filePath.endsWith(".jsonc")) return "json";
  // Fall back to agent-specific defaults
  if (agent === "goose") return "yaml";
  if (agent === "codex") return "toml";
  return "json";
};

// ---------------------------------------------------------------------------
// JSONC parser — two-pass: strip comments, then strip trailing commas
// ---------------------------------------------------------------------------

const stripComments = (text: string): string => {
  let result = "";
  let i = 0;
  const len = text.length;

  while (i < len) {
    // String literal — pass through verbatim (don't treat // or /* inside as comments)
    if (text[i] === '"') {
      result += text[i++];
      while (i < len) {
        if (text[i] === "\\") {
          result += text[i++];
          if (i < len) result += text[i++];
        } else if (text[i] === '"') {
          result += text[i++];
          break;
        } else {
          result += text[i++];
        }
      }
      continue;
    }

    // Line comment — replace with newline to preserve line numbers
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < len && text[i] !== "\n") i++;
      continue;
    }

    // Block comment — replace with a space
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      result += " ";
      while (i < len && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    result += text[i++];
  }

  return result;
};

const stripTrailingCommas = (text: string): string => {
  let result = "";
  let i = 0;
  const len = text.length;

  while (i < len) {
    // String literal — pass through verbatim
    if (text[i] === '"') {
      result += text[i++];
      while (i < len) {
        if (text[i] === "\\") {
          result += text[i++];
          if (i < len) result += text[i++];
        } else if (text[i] === '"') {
          result += text[i++];
          break;
        } else {
          result += text[i++];
        }
      }
      continue;
    }

    // Trailing comma — look ahead through whitespace for } or ]
    if (text[i] === ",") {
      let j = i + 1;
      while (j < len && /\s/.test(text[j])) j++;
      if (j < len && (text[j] === "}" || text[j] === "]")) {
        i++;
        continue;
      }
    }

    result += text[i++];
  }

  return result;
};

const stripJsoncComments = (text: string): string => stripTrailingCommas(stripComments(text));

// ---------------------------------------------------------------------------
// Parse raw content by format
// ---------------------------------------------------------------------------

const parseJson = (content: string): unknown => {
  return JSON.parse(stripJsoncComments(content));
};

const parseYamlContent = (content: string): unknown => yamlParse(content);

const parseTomlContent = (content: string): unknown => tomlParse(content);

export const parseContent = async (content: string, format: ConfigFormat): Promise<unknown> => {
  switch (format) {
    case "json":
      return parseJson(content);
    case "yaml":
      return parseYamlContent(content);
    case "toml":
      return parseTomlContent(content);
  }
};

// ---------------------------------------------------------------------------
// Detect agent from filename heuristics
// ---------------------------------------------------------------------------

export const detectAgentFromFilename = (filename: string): AgentKey | null => {
  const lower = filename.toLowerCase();
  if (lower === "opencode.json" || lower === "opencode.jsonc") return "opencode";
  if (lower === ".mcp.json" || lower === "mcp.json") return "claude-code";
  if (lower === "claude_desktop_config.json") return "claude-desktop";
  if (lower === "cline_mcp_settings.json") return "cline";
  if (lower === "config.toml") return "codex";
  if (lower === "config.yaml" || lower === "config.yml") return "goose";
  if (lower === "mcp-config.json") return "copilot";
  if (lower === "mcp_config.json") return "antigravity";
  if (lower === "mcporter.json" || lower === "mcporter.jsonc") return "mcporter";
  if (lower === ".claude.json") return "claude-code";
  return null;
};

// ---------------------------------------------------------------------------
// Detect agent from parsed content heuristics
// ---------------------------------------------------------------------------

export const detectAgentFromContent = (parsed: unknown): AgentKey | null => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  if ("mcp" in obj && obj.mcp && typeof obj.mcp === "object") return "opencode";
  if ("context_servers" in obj) return "zed";
  if ("extensions" in obj) return "goose";
  if ("mcp_servers" in obj) return "codex";
  if ("servers" in obj) return "vscode";
  if ("mcpServers" in obj) return "claude-code"; // default for mcpServers
  return null;
};

// ---------------------------------------------------------------------------
// Read from file path
// ---------------------------------------------------------------------------

export const readAgentConfigFile = async (
  filePath: string,
  agent: AgentKey,
): Promise<NormalizedServer[]> => {
  if (!existsSync(filePath)) {
    throw new AgentImportError(`Config file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  return parseAgentConfigContent(content, filePath, agent);
};

// ---------------------------------------------------------------------------
// Parse from raw content (used by web drag-drop and tests)
// ---------------------------------------------------------------------------

export const parseAgentConfigContent = async (
  content: string,
  filenameHint: string,
  agentHint?: AgentKey,
): Promise<NormalizedServer[]> => {
  let agent = agentHint;

  // Detect format from filename hint
  const format = detectFormat(filenameHint, agent ?? "claude-code");

  let parsed: unknown;
  try {
    parsed = await parseContent(content, format);
  } catch (err) {
    throw new AgentImportError(
      `Failed to parse config file: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (!agent) {
    const base = filenameHint.split(/[\\/]/).pop() ?? filenameHint;
    agent = detectAgentFromFilename(base) ?? detectAgentFromContent(parsed) ?? "claude-code";
  }

  return normalizeAgentConfig(agent, parsed);
};

// ---------------------------------------------------------------------------
// Resolve and read from agent global or local path
// ---------------------------------------------------------------------------

export interface ResolvedAgentConfig {
  readonly filePath: string;
  readonly agent: AgentKey;
  readonly servers: NormalizedServer[];
}

export const findAndReadAgentConfig = async (
  agent: AgentKey,
  options?: { cwd?: string },
): Promise<ResolvedAgentConfig> => {
  const env = getCurrentPlatformEnv();
  const cwd = options?.cwd ?? process.cwd();

  // Check local paths first
  for (const rel of getLocalConfigPaths(agent)) {
    const full = join(cwd, rel);
    if (existsSync(full)) {
      const servers = await readAgentConfigFile(full, agent);
      return { filePath: full, agent, servers };
    }
  }

  // Then global paths
  for (const full of getGlobalConfigPaths(agent, env)) {
    if (existsSync(full)) {
      const servers = await readAgentConfigFile(full, agent);
      return { filePath: full, agent, servers };
    }
  }

  const tried = [
    ...getLocalConfigPaths(agent).map((p) => join(cwd, p)),
    ...getGlobalConfigPaths(agent, env),
  ].join(", ");

  throw new AgentImportError(`No config file found for agent "${agent}". Tried: ${tried}`);
};

// ---------------------------------------------------------------------------
// Detect all agents with an existing config file
// ---------------------------------------------------------------------------

export interface DetectedAgent {
  readonly agent: AgentKey;
  readonly filePath: string;
  readonly serverCount: number;
}

const ALL_AGENTS: AgentKey[] = [
  "opencode",
  "claude-code",
  "claude-desktop",
  "amp",
  "cursor",
  "vscode",
  "cline",
  "cline-cli",
  "zed",
  "goose",
  "codex",
  "gemini-cli",
  "copilot",
  "antigravity",
  "mcporter",
];

export const detectInstalledAgents = async (options?: {
  cwd?: string;
}): Promise<DetectedAgent[]> => {
  const env = getCurrentPlatformEnv();
  const cwd = options?.cwd ?? process.cwd();
  const results: DetectedAgent[] = [];
  const seen = new Set<string>();

  for (const agent of ALL_AGENTS) {
    const paths = [
      ...getLocalConfigPaths(agent).map((p) => join(cwd, p)),
      ...getGlobalConfigPaths(agent, env),
    ];

    for (const filePath of paths) {
      if (seen.has(filePath)) continue;
      if (!existsSync(filePath)) continue;
      seen.add(filePath);
      try {
        const servers = await readAgentConfigFile(filePath, agent);
        if (servers.length > 0) {
          results.push({ agent, filePath, serverCount: servers.length });
        }
      } catch {
        // skip unreadable files
      }
      break; // only first found path per agent
    }
  }

  return results;
};

// ---------------------------------------------------------------------------
// Re-export dirname for consumers that need it
// ---------------------------------------------------------------------------
export { dirname };

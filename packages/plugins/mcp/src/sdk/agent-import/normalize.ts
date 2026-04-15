// ---------------------------------------------------------------------------
// Agent config normalization — maps agent-specific shapes → NormalizedServer
// ---------------------------------------------------------------------------

import { deriveMcpNamespace } from "../manifest";
import type { AgentKey, NormalizedServer, NormalizedServerConfig } from "./types";

// ---------------------------------------------------------------------------
// Raw server shapes (loosely typed — we handle unknown agent configs)
// ---------------------------------------------------------------------------

type RawServer = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

const strRecord = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const strArray = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
};

// ---------------------------------------------------------------------------
// Standard mcpServers format (Claude Code, Cursor, Cline, Gemini CLI, etc.)
// {command, args, env} or {url, type, headers}
// ---------------------------------------------------------------------------

const normalizeStandard = (name: string, raw: RawServer): NormalizedServer | null => {
  const url = str(raw.url) ?? str(raw.serverUrl) ?? str(raw.uri);
  if (url) {
    const transport = normalizeRemoteTransport(str(raw.type));
    const config: NormalizedServerConfig = {
      transport: "remote",
      endpoint: url,
      headers: strRecord(raw.headers),
      remoteTransport: transport,
    };
    return {
      name,
      suggestedNamespace: deriveMcpNamespace({ name, endpoint: url }),
      config,
    };
  }

  const command = str(raw.command);
  if (command) {
    return {
      name,
      suggestedNamespace: deriveMcpNamespace({ name, command }),
      config: {
        transport: "stdio",
        command,
        args: strArray(raw.args),
        env: strRecord(raw.env),
        cwd: str(raw.cwd),
      },
    };
  }

  return null;
};

const normalizeRemoteTransport = (t: string | undefined): "streamable-http" | "sse" | "auto" => {
  if (t === "sse") return "sse";
  if (t === "streamableHttp" || t === "streamable-http" || t === "http") return "streamable-http";
  return "auto";
};

// ---------------------------------------------------------------------------
// OpenCode: {mcp: {name: {type:"remote"|"local", url?, command:[...], environment:{}}}}
// ---------------------------------------------------------------------------

const normalizeOpenCode = (name: string, raw: RawServer): NormalizedServer | null => {
  const url = str(raw.url);
  if (url || str(raw.type) === "remote") {
    if (!url) return null;
    return {
      name,
      suggestedNamespace: deriveMcpNamespace({ name, endpoint: url }),
      config: {
        transport: "remote",
        endpoint: url,
        headers: strRecord(raw.headers),
        remoteTransport: "auto",
      },
    };
  }

  // command is array in opencode: ["node", "server.js"] or string
  let command: string | undefined;
  let args: string[] | undefined;

  if (Array.isArray(raw.command)) {
    const parts = raw.command.filter((x): x is string => typeof x === "string");
    command = parts[0];
    args = parts.slice(1);
  } else {
    command = str(raw.command);
    args = strArray(raw.args);
  }

  if (!command) return null;

  const env = strRecord(raw.environment) ?? strRecord(raw.env);

  return {
    name,
    suggestedNamespace: deriveMcpNamespace({ name, command }),
    config: { transport: "stdio", command, args, env },
  };
};

// ---------------------------------------------------------------------------
// Goose: {extensions: {name: {type:"streamable_http"|"sse"|"stdio", uri?, cmd?, args?, envs:{}}}}
// ---------------------------------------------------------------------------

const normalizeGoose = (name: string, raw: RawServer): NormalizedServer | null => {
  const uri = str(raw.uri);
  if (uri) {
    const t = str(raw.type);
    const transport = t === "sse" ? "sse" : "streamable-http";
    return {
      name,
      suggestedNamespace: deriveMcpNamespace({ name, endpoint: uri }),
      config: {
        transport: "remote",
        endpoint: uri,
        headers: strRecord(raw.headers),
        remoteTransport: transport,
      },
    };
  }

  const cmd = str(raw.cmd) ?? str(raw.command);
  if (!cmd) return null;

  const env = strRecord(raw.envs) ?? strRecord(raw.env);

  return {
    name,
    suggestedNamespace: deriveMcpNamespace({ name, command: cmd }),
    config: {
      transport: "stdio",
      command: cmd,
      args: strArray(raw.args),
      env,
    },
  };
};

// ---------------------------------------------------------------------------
// Codex: {mcp_servers: {name: {type:"http"|"sse", url?} or {command, args, env}}}
// http_headers used instead of headers in codex
// ---------------------------------------------------------------------------

const normalizeCodex = (name: string, raw: RawServer): NormalizedServer | null => {
  const url = str(raw.url);
  if (url) {
    const headers = strRecord(raw.http_headers) ?? strRecord(raw.headers);
    const t = str(raw.type);
    return {
      name,
      suggestedNamespace: deriveMcpNamespace({ name, endpoint: url }),
      config: {
        transport: "remote",
        endpoint: url,
        headers,
        remoteTransport: normalizeRemoteTransport(t),
      },
    };
  }

  const command = str(raw.command);
  if (!command) return null;

  return {
    name,
    suggestedNamespace: deriveMcpNamespace({ name, command }),
    config: {
      transport: "stdio",
      command,
      args: strArray(raw.args),
      env: strRecord(raw.env),
    },
  };
};

// ---------------------------------------------------------------------------
// Zed: {context_servers: {name: {source:"custom", type?, url?, command?, args?, env}}}
// ---------------------------------------------------------------------------

const normalizeZed = (name: string, raw: RawServer): NormalizedServer | null => {
  const url = str(raw.url);
  if (url) {
    return {
      name,
      suggestedNamespace: deriveMcpNamespace({ name, endpoint: url }),
      config: {
        transport: "remote",
        endpoint: url,
        headers: strRecord(raw.headers),
        remoteTransport: normalizeRemoteTransport(str(raw.type)),
      },
    };
  }

  const command = str(raw.command);
  if (!command) return null;

  return {
    name,
    suggestedNamespace: deriveMcpNamespace({ name, command }),
    config: {
      transport: "stdio",
      command,
      args: strArray(raw.args),
      env: strRecord(raw.env),
    },
  };
};

// ---------------------------------------------------------------------------
// VS Code: {servers: {name: {type:"http"|"stdio", url?, command?, args}}}
// ---------------------------------------------------------------------------

const normalizeVSCode = (name: string, raw: RawServer): NormalizedServer | null => {
  const url = str(raw.url);
  if (url) {
    return {
      name,
      suggestedNamespace: deriveMcpNamespace({ name, endpoint: url }),
      config: {
        transport: "remote",
        endpoint: url,
        headers: strRecord(raw.headers),
        remoteTransport: normalizeRemoteTransport(str(raw.type)),
      },
    };
  }

  const command = str(raw.command);
  if (!command) return null;

  return {
    name,
    suggestedNamespace: deriveMcpNamespace({ name, command }),
    config: {
      transport: "stdio",
      command,
      args: strArray(raw.args),
      env: strRecord(raw.env),
    },
  };
};

// ---------------------------------------------------------------------------
// Dispatch by agent key
// ---------------------------------------------------------------------------

type NormalizeFn = (name: string, raw: RawServer) => NormalizedServer | null;

const normalizersByAgent: Record<AgentKey, NormalizeFn> = {
  opencode: normalizeOpenCode,
  "claude-code": normalizeStandard,
  "claude-desktop": normalizeStandard,
  amp: normalizeStandard,
  cursor: normalizeStandard,
  vscode: normalizeVSCode,
  cline: normalizeStandard,
  "cline-cli": normalizeStandard,
  zed: normalizeZed,
  goose: normalizeGoose,
  codex: normalizeCodex,
  "gemini-cli": normalizeStandard,
  copilot: normalizeStandard,
  antigravity: normalizeStandard,
  mcporter: normalizeStandard,
};

// ---------------------------------------------------------------------------
// Config key by agent — where in the parsed object the servers live
// ---------------------------------------------------------------------------

export const configKeyByAgent: Record<AgentKey, string> = {
  opencode: "mcp",
  "claude-code": "mcpServers",
  "claude-desktop": "mcpServers",
  amp: "mcpServers",
  cursor: "mcpServers",
  vscode: "servers",
  cline: "mcpServers",
  "cline-cli": "mcpServers",
  zed: "context_servers",
  goose: "extensions",
  codex: "mcp_servers",
  "gemini-cli": "mcpServers",
  copilot: "mcpServers",
  antigravity: "mcpServers",
  mcporter: "mcpServers",
};

// ---------------------------------------------------------------------------
// Extract servers object from parsed config using dot-notation key
// ---------------------------------------------------------------------------

const getNestedValue = (obj: unknown, key: string): unknown => {
  const parts = key.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
};

// ---------------------------------------------------------------------------
// Public: normalize all servers from a parsed config object
// ---------------------------------------------------------------------------

export const normalizeAgentConfig = (agent: AgentKey, parsed: unknown): NormalizedServer[] => {
  const configKey = configKeyByAgent[agent];
  const serversObj = getNestedValue(parsed, configKey);

  if (!serversObj || typeof serversObj !== "object" || Array.isArray(serversObj)) {
    return [];
  }

  const normalize = normalizersByAgent[agent];
  const results: NormalizedServer[] = [];

  for (const [name, raw] of Object.entries(serversObj as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const normalized = normalize(name, raw as RawServer);
    if (normalized) results.push(normalized);
  }

  return results;
};

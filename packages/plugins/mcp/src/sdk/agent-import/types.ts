// ---------------------------------------------------------------------------
// Agent import — shared types
// ---------------------------------------------------------------------------

export type AgentKey =
  | "opencode"
  | "claude-code"
  | "claude-desktop"
  | "amp"
  | "cursor"
  | "vscode"
  | "cline"
  | "cline-cli"
  | "zed"
  | "goose"
  | "codex"
  | "gemini-cli"
  | "copilot"
  | "antigravity"
  | "mcporter";

export type ConfigFormat = "json" | "yaml" | "toml";

// ---------------------------------------------------------------------------
// Normalized server — canonical intermediate representation
// ---------------------------------------------------------------------------

export type NormalizedServerConfig =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: string[];
      readonly env?: Record<string, string>;
      readonly cwd?: string;
    }
  | {
      readonly transport: "remote";
      readonly endpoint: string;
      readonly headers?: Record<string, string>;
      readonly remoteTransport?: "streamable-http" | "sse" | "auto";
    };

export interface NormalizedServer {
  readonly suggestedNamespace: string;
  readonly name: string;
  readonly config: NormalizedServerConfig;
}

// ---------------------------------------------------------------------------
// Import errors
// ---------------------------------------------------------------------------

export class AgentImportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentImportError";
  }
}

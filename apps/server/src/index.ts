/**
 * OpenAssistant Server — Elysia + Eden Treaty
 *
 * Starts the server with tool sources loaded from config.
 * The exported App type is consumed by Eden Treaty clients.
 */

import { readFileSync } from "node:fs";
import { createApp } from "./routes.js";
import { createPiAiModel } from "@openassistant/core";
import { mergeToolTrees, type ToolTree } from "@openassistant/core/tools";
import { generateMcpTools } from "@openassistant/tool-gen/mcp";
import type { McpToolSource } from "@openassistant/tool-gen/mcp";

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Anthropic API key from (in order):
 * 1. ANTHROPIC_OAUTH_TOKEN env var
 * 2. ANTHROPIC_API_KEY env var
 * 3. Claude Code's credential store (~/.claude/.credentials.json)
 */
function getAnthropicApiKey(): string | undefined {
  if (process.env["ANTHROPIC_OAUTH_TOKEN"]) return process.env["ANTHROPIC_OAUTH_TOKEN"];
  if (process.env["ANTHROPIC_API_KEY"]) return process.env["ANTHROPIC_API_KEY"];

  try {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
    const text = readFileSync(`${home}/.claude/.credentials.json`, "utf-8");
    const creds = JSON.parse(text);
    const token = (creds as Record<string, Record<string, unknown>>)?.["claudeAiOauth"]?.["accessToken"];
    if (typeof token === "string" && token.startsWith("sk-ant-")) {
      return token;
    }
  } catch {
    // No credentials file
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Tool source config
// ---------------------------------------------------------------------------

const mcpSources: McpToolSource[] = [
  {
    name: "answeroverflow",
    url: "https://www.answeroverflow.com/mcp",
    defaultApproval: "auto",
  },
];

// ---------------------------------------------------------------------------
// Tool loading
// ---------------------------------------------------------------------------

async function loadTools(): Promise<ToolTree> {
  const trees: ToolTree[] = [];

  for (const source of mcpSources) {
    try {
      console.log(`Loading MCP tools from ${source.name} (${source.url})...`);
      const result = await generateMcpTools(source);
      trees.push(result.tools);
      console.log(`  Loaded ${Object.keys(result.tools[source.name] ?? {}).length} tools from ${source.name}`);
    } catch (error) {
      console.error(`  Failed to load ${source.name}:`, error instanceof Error ? error.message : error);
    }
  }

  return mergeToolTrees(...trees);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = Number(process.env["PORT"] ?? 3000);

const apiKey = getAnthropicApiKey();
if (!apiKey) {
  console.error("WARNING: No Anthropic API key found. Set ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, or have Claude Code credentials at ~/.claude/.credentials.json");
}

console.log("Loading tools...");
const tools = await loadTools();
const model = createPiAiModel({ apiKey });

const app = createApp({ tools, model });

app.listen(PORT);

console.log(`\u{1f98a} OpenAssistant server running at http://localhost:${PORT}`);

// Re-export the app type for Eden Treaty clients
export type { App } from "./routes.js";

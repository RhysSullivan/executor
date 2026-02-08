/**
 * Assistant Server entry point.
 *
 * Bootstraps executor context, sets up the agent, and serves the API.
 * The agent connects to the executor via MCP — no Eden Treaty needed here.
 */

import { readFileSync } from "node:fs";
import { createApp } from "./routes";
import { createModel } from "@assistant/core";

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

function getAnthropicApiKey(): string | undefined {
  if (Bun.env.ANTHROPIC_OAUTH_TOKEN) return Bun.env.ANTHROPIC_OAUTH_TOKEN;
  if (Bun.env.ANTHROPIC_API_KEY) return Bun.env.ANTHROPIC_API_KEY;

  try {
    const home = Bun.env.HOME ?? Bun.env.USERPROFILE ?? "";
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
// Config
// ---------------------------------------------------------------------------

const PORT = Number(Bun.env.PORT ?? 3000);
const EXECUTOR_URL = Bun.env.EXECUTOR_URL ?? "http://localhost:4001";
const CONVEX_URL = Bun.env.CONVEX_URL ?? "http://127.0.0.1:3210";

const apiKey = getAnthropicApiKey();
if (!apiKey) {
  console.error("WARNING: No Anthropic API key found. Set ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN.");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const model = createModel({ apiKey });

// Bootstrap an anonymous context on the executor
const bootstrapResp = await fetch(`${EXECUTOR_URL}/api/auth/anonymous/bootstrap`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});

if (!bootstrapResp.ok) {
  console.error("Failed to bootstrap executor context. Is the executor running at", EXECUTOR_URL, "?");
  process.exit(1);
}

const anonCtx = await bootstrapResp.json() as {
  workspaceId: string;
  actorId: string;
  clientId: string;
};

console.log(`[assistant] executor context: workspace=${anonCtx.workspaceId} actor=${anonCtx.actorId}`);

// Build context string
const contextLines: string[] = [];
if (Bun.env.POSTHOG_PROJECT_ID) {
  contextLines.push(`- PostHog project ID: ${Bun.env.POSTHOG_PROJECT_ID}`);
}

const app = createApp({
  executorUrl: EXECUTOR_URL,
  generate: (messages, tools) => model.generate(messages, tools),
  workspaceId: anonCtx.workspaceId,
  actorId: anonCtx.actorId,
  clientId: anonCtx.clientId,
  context: contextLines.length > 0 ? contextLines.join("\n") : undefined,
  convexUrl: CONVEX_URL,
});

app.listen(PORT);

console.log(`[assistant] server running at http://localhost:${PORT}`);
console.log(`[assistant] executor at ${EXECUTOR_URL}`);

export type { App } from "./routes";

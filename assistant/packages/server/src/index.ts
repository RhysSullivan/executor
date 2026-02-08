/**
 * Assistant Server entry point.
 */

import { createApp } from "./routes";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@executor/convex/_generated/api";

const PORT = Number(Bun.env.PORT ?? 3000);
const CONVEX_URL = Bun.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const EXECUTOR_URL = Bun.env.EXECUTOR_URL
  ?? Bun.env.CONVEX_SITE_URL
  ?? (CONVEX_URL.includes(".convex.cloud")
    ? CONVEX_URL.replace(".convex.cloud", ".convex.site")
    : CONVEX_URL);
const PINNED_WORKSPACE_ID = Bun.env.EXECUTOR_WORKSPACE_ID?.trim();
const PINNED_ACTOR_ID = Bun.env.EXECUTOR_ACTOR_ID?.trim();
const PINNED_CLIENT_ID = Bun.env.EXECUTOR_CLIENT_ID?.trim();
const ANON_SESSION_ID = Bun.env.EXECUTOR_ANON_SESSION_ID?.trim();

// Bootstrap anonymous context on executor Convex backend
const convex = new ConvexHttpClient(CONVEX_URL);
let ctx: { workspaceId: string; actorId: string; clientId?: string };

if (PINNED_WORKSPACE_ID && PINNED_ACTOR_ID) {
  ctx = {
    workspaceId: PINNED_WORKSPACE_ID,
    actorId: PINNED_ACTOR_ID,
    clientId: PINNED_CLIENT_ID,
  };
} else {
  try {
    const bootstrap = await convex.mutation(api.database.bootstrapAnonymousSession, {
      sessionId: ANON_SESSION_ID,
    });
    ctx = {
      workspaceId: bootstrap.workspaceId,
      actorId: bootstrap.actorId,
      clientId: PINNED_CLIENT_ID ?? bootstrap.clientId,
    };
  } catch (error) {
    console.error("Failed to bootstrap executor context from Convex at", CONVEX_URL, error);
    process.exit(1);
  }
}

console.log(`[assistant] executor context: workspace=${ctx.workspaceId} actor=${ctx.actorId}`);
if (ANON_SESSION_ID) {
  console.log(`[assistant] executor anon session: ${ANON_SESSION_ID}`);
}

const contextLines: string[] = [];
if (Bun.env.POSTHOG_PROJECT_ID) contextLines.push(`- PostHog project ID: ${Bun.env.POSTHOG_PROJECT_ID}`);

const app = createApp({
  executorUrl: EXECUTOR_URL,
  workspaceId: ctx.workspaceId,
  actorId: ctx.actorId,
  clientId: ctx.clientId,
  context: contextLines.length > 0 ? contextLines.join("\n") : undefined,
  convexUrl: CONVEX_URL,
});

app.listen(PORT);
console.log(`[assistant] server running at http://localhost:${PORT}`);
console.log(`[assistant] executor at ${EXECUTOR_URL}`);

export type { App } from "./routes";

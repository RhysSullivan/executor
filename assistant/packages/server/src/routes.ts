/**
 * Elysia server routes.
 *
 * POST   /api/tasks             — Create an agent task (fires agent in background, writes state to Convex)
 * GET    /api/context           — Returns executor workspace/actor context
 */

import { Elysia, t } from "elysia";
import { createAgent } from "@assistant/core";
import type { GenerateResult, Message, ToolDef, TaskEvent } from "@assistant/core";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@executor/convex/_generated/api";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ServerOptions {
  readonly executorUrl: string;
  readonly generate: (messages: Message[], tools?: ToolDef[]) => Promise<GenerateResult>;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly clientId?: string;
  readonly context?: string;
  readonly convexUrl: string;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function createApp(options: ServerOptions) {
  const agent = createAgent({
    executorUrl: options.executorUrl,
    generate: options.generate,
    workspaceId: options.workspaceId,
    actorId: options.actorId,
    clientId: options.clientId,
    context: options.context,
  });

  const convex = new ConvexHttpClient(options.convexUrl);

  let counter = 0;
  function generateAgentTaskId(): string {
    return `atask_${Date.now()}_${++counter}`;
  }

  const app = new Elysia()
    // Expose executor context so the bot can query Convex
    .get("/api/context", () => ({
      workspaceId: options.workspaceId,
      actorId: options.actorId,
      clientId: options.clientId,
    }))

    .post("/api/tasks", async ({ body }) => {
      const agentTaskId = generateAgentTaskId();

      // Create agent task in Convex
      await convex.mutation(api.database.createAgentTask, {
        id: agentTaskId,
        prompt: body.prompt,
        requesterId: body.requesterId,
        workspaceId: options.workspaceId,
        actorId: options.actorId,
      });

      // Fire and forget — agent runs, writes results to Convex
      let toolCalls = 0;

      agent.run(body.prompt, (event: TaskEvent) => {
        if (event.type === "code_result") {
          toolCalls++;
        }

        if (event.type === "agent_message") {
          convex.mutation(api.database.updateAgentTask, {
            agentTaskId,
            resultText: event.text,
            codeRuns: toolCalls,
          }).catch((err) => console.error(`[agent task ${agentTaskId}] convex write error:`, err));
        }

        if (event.type === "completed") {
          convex.mutation(api.database.updateAgentTask, {
            agentTaskId,
            status: "completed",
            codeRuns: toolCalls,
          }).catch((err) => console.error(`[agent task ${agentTaskId}] convex write error:`, err));
        }

        if (event.type === "error") {
          convex.mutation(api.database.updateAgentTask, {
            agentTaskId,
            status: "failed",
            error: event.error,
            codeRuns: toolCalls,
          }).catch((err) => console.error(`[agent task ${agentTaskId}] convex write error:`, err));
        }
      }).catch((err) => {
        console.error(`[agent task ${agentTaskId}] agent error:`, err);
        convex.mutation(api.database.updateAgentTask, {
          agentTaskId,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          codeRuns: toolCalls,
        }).catch((err2) => console.error(`[agent task ${agentTaskId}] convex write error:`, err2));
      });

      return { agentTaskId, workspaceId: options.workspaceId };
    }, {
      body: t.Object({
        prompt: t.String({ minLength: 1 }),
        requesterId: t.String({ minLength: 1 }),
      }),
    });

  return app;
}

export type App = ReturnType<typeof createApp>;

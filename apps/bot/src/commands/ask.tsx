/**
 * /ask command handler
 *
 * 1. Defers the interaction immediately (Discord has a 3s window)
 * 2. Creates a task on the server via Eden Treaty
 * 3. Renders a live-updating Reacord message (uses editReply since deferred)
 * 4. Polls the server for task events and updates the message
 * 5. Handles approval button clicks by calling the server
 */

import type { ChatInputCommandInteraction, ButtonInteraction, CommandInteraction } from "discord.js";
import type { Client as ApiClient } from "@openassistant/server/client";
import { unwrap } from "@openassistant/server/client";
import type { ReacordInstance } from "@openassistant/reacord";
import { Effect, Runtime } from "effect";
import {
  TaskMessage,
  initialTaskState,
  reduceTaskEvent,
  type TaskState,
} from "../views/task-message";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AskCommandDeps {
  readonly api: ApiClient;
  readonly reacord: {
    reply: (interaction: CommandInteraction, content: React.ReactNode) => Effect.Effect<ReacordInstance>;
  };
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export async function handleAskCommand(
  interaction: ChatInputCommandInteraction,
  deps: AskCommandDeps,
): Promise<void> {
  const prompt = interaction.options.getString("prompt", true);
  const requesterId = interaction.user.id;

  // Defer immediately — Discord interactions expire after 3 seconds.
  // Reacord checks interaction.deferred and uses editReply instead of reply.
  await interaction.deferReply();

  // 1. Create task on the server
  let taskId: string;
  try {
    const data = await unwrap(
      deps.api.api.tasks.post({
        prompt,
        requesterId,
      }),
    );
    taskId = data.taskId;
  } catch (error) {
    await interaction.editReply({
      content: `\u274c Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  // 2. Render initial message via Reacord
  let state = initialTaskState();

  const instance = await Runtime.runPromise(Runtime.defaultRuntime)(
    deps.reacord.reply(
      interaction,
      <TaskMessage
        prompt={prompt}
        state={state}
        onApprove={(callId) => handleApproval(callId, "approved", deps)}
        onDeny={(callId) => handleApproval(callId, "denied", deps)}
      />,
    ),
  );

  // 3. Poll for events and update the message
  await pollAndUpdate(taskId, prompt, state, instance, deps);
}

// ---------------------------------------------------------------------------
// Event polling loop
// ---------------------------------------------------------------------------

async function pollAndUpdate(
  taskId: string,
  prompt: string,
  initialState: TaskState,
  instance: ReacordInstance,
  deps: AskCommandDeps,
): Promise<void> {
  let state = initialState;

  // Poll every 500ms for new events
  const maxPolls = 600; // 5 minutes max
  for (let i = 0; i < maxPolls; i++) {
    await Bun.sleep(500);

    try {
      const task = await unwrap(deps.api.api.tasks({ id: taskId }).get());

      // Check if there are pending approvals we haven't seen
      for (const approval of task.pendingApprovals) {
        if (!state.pendingApprovals.find((a) => a.id === approval.callId)) {
          state = reduceTaskEvent(state, {
            type: "approval_request",
            id: approval.callId,
            toolPath: approval.toolPath,
            input: undefined,
            preview: { title: `${approval.toolPath}` },
          });
        }
      }

      // Remove approvals that the server no longer reports
      const serverCallIds = new Set(task.pendingApprovals.map((a) => a.callId));
      for (const approval of state.pendingApprovals) {
        if (!serverCallIds.has(approval.id)) {
          state = reduceTaskEvent(state, {
            type: "approval_resolved",
            id: approval.id,
            decision: "approved",
          });
        }
      }

      // Check for completion
      if (task.status === "completed" && state.status !== "completed") {
        if (task.resultText) {
          state = reduceTaskEvent(state, {
            type: "agent_message",
            text: task.resultText,
          });
        }
        state = reduceTaskEvent(state, {
          type: "completed",
          receipts: [],
        });
      } else if (task.status === "failed" && state.status !== "failed") {
        state = reduceTaskEvent(state, {
          type: "error",
          error: task.errorMessage ?? "Task failed (unknown error)",
        });
      } else if (task.status === "cancelled" && state.status !== "cancelled") {
        state = { ...state, status: "cancelled", statusMessage: "Cancelled" };
      }

      // Re-render
      instance.render(
        <TaskMessage
          prompt={prompt}
          state={state}
          onApprove={(callId) => handleApproval(callId, "approved", deps)}
          onDeny={(callId) => handleApproval(callId, "denied", deps)}
        />,
      );

      // Stop polling if done
      if (state.status !== "running") {
        setTimeout(() => instance.deactivate(), 5000);
        return;
      }
    } catch (error) {
      console.error(`[poll ${taskId}] error:`, error);
    }
  }

  // Timeout
  state = { ...state, status: "failed", error: "Task timed out after 5 minutes", statusMessage: "Timed out" };
  instance.render(
    <TaskMessage prompt={prompt} state={state} />,
  );
  instance.deactivate();
}

// ---------------------------------------------------------------------------
// Approval handler
// ---------------------------------------------------------------------------

async function handleApproval(
  callId: string,
  decision: "approved" | "denied",
  deps: AskCommandDeps,
): Promise<void> {
  try {
    await unwrap(
      deps.api.api.approvals({ callId }).post({ decision }),
    );
  } catch (error) {
    console.error(`[approval ${callId}] error:`, error);
  }
}

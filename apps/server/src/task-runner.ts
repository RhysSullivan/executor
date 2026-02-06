/**
 * Task runner — wires createAgent to the task state system.
 *
 * Starts an agent run for a task, emitting TaskEvents to state,
 * with approval resolution via the pending approval registry.
 */

import type { ToolTree, ApprovalRequest, ApprovalDecision } from "@openassistant/core/tools";
import type { LanguageModel } from "@openassistant/core/agent";
import { createAgent } from "@openassistant/core/agent";
import {
  emitTaskEvent,
  getTask,
  registerApproval,
} from "./state.js";

export interface TaskRunnerOptions {
  readonly tools: ToolTree;
  readonly model: LanguageModel;
}

/**
 * Run an agent turn for a task. Emits events to the task's event stream
 * and registers approval requests that can be resolved via the REST API.
 */
export async function runTask(
  taskId: string,
  prompt: string,
  options: TaskRunnerOptions,
): Promise<void> {
  const task = getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const agent = createAgent({
    tools: options.tools,
    model: options.model,
    requestApproval: (request: ApprovalRequest): Promise<ApprovalDecision> => {
      return new Promise<ApprovalDecision>((resolve) => {
        // Register the pending approval so REST API can resolve it
        registerApproval({
          callId: request.callId,
          taskId,
          toolPath: request.toolPath,
          input: request.input,
          resolve,
        });
      });
    },
    onEvent: (event) => {
      emitTaskEvent(taskId, event);
    },
  });

  try {
    await agent.run(prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`[task ${taskId}] agent error:`, message);
    if (stack) console.error(stack);
    emitTaskEvent(taskId, {
      type: "error",
      error: message,
    });
  }
}

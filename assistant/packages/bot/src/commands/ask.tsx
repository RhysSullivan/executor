/**
 * /ask command handler
 */

import type { ChatInputCommandInteraction, CommandInteraction } from "discord.js";
import type { Client } from "@assistant/server/client";
import { unwrap } from "@assistant/server/client";
import type { Treaty } from "@elysiajs/eden";
import type { ConvexReactClient } from "convex/react";
import type { ReacordInstance } from "@openassistant/reacord";
import { Effect, Runtime } from "effect";
import { TaskMessage } from "../views/task-message";

interface AskCommandDeps {
  readonly api: Client;
  readonly executor: ReturnType<typeof import("@elysiajs/eden").treaty>;
  readonly convex: ConvexReactClient;
  readonly reacord: {
    reply: (interaction: CommandInteraction, content: React.ReactNode) => Effect.Effect<ReacordInstance>;
  };
}

export async function handleAskCommand(
  interaction: ChatInputCommandInteraction,
  deps: AskCommandDeps,
): Promise<void> {
  const prompt = interaction.options.getString("prompt", true);
  const requesterId = interaction.user.id;

  await interaction.deferReply();

  let taskId: string;
  let workspaceId: string;
  try {
    const data = await unwrap(
      deps.api.api.tasks.post({ prompt, requesterId }),
    );
    taskId = data.taskId;
    workspaceId = data.workspaceId;
  } catch (error) {
    await interaction.editReply({
      content: `\u274c Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  await Runtime.runPromise(Runtime.defaultRuntime)(
    deps.reacord.reply(
      interaction,
      <TaskMessage
        taskId={taskId}
        prompt={prompt}
        workspaceId={workspaceId}
        executor={deps.executor}
        convex={deps.convex}
      />,
    ),
  );
}

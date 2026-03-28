import type { ExecutionInteraction } from "@executor/platform-sdk/schema";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type ParsedInteractionPayload = {
  message: string;
  mode: "form" | "url";
  url?: string;
  requestedSchema?: Record<string, unknown>;
};

export const parseInteractionPayload = (
  interaction: ExecutionInteraction,
): ParsedInteractionPayload | null => {
  try {
    const parsed = JSON.parse(interaction.payloadJson) as {
      elicitation?: {
        message?: string;
        mode?: "form" | "url";
        url?: string;
        requestedSchema?: Record<string, unknown>;
      };
    };

    if (!parsed.elicitation || typeof parsed.elicitation.message !== "string") {
      return null;
    }

    return {
      message: parsed.elicitation.message,
      mode: parsed.elicitation.mode === "url" ? "url" : "form",
      url: parsed.elicitation.url,
      requestedSchema:
        isRecord(parsed.elicitation.requestedSchema)
          ? parsed.elicitation.requestedSchema
          : undefined,
    };
  } catch {
    return null;
  }
};

const shellEscape = (value: string): string => {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

const renderCommand = (argv: readonly string[]): string => argv.map(shellEscape).join(" ");

const describePauseReason = (interaction: ExecutionInteraction): string => {
  switch (interaction.purpose) {
    case "tool_execution_gate":
      return "this tool call requires approval before executor can continue";
    default:
      return "executor needs additional input before it can continue";
  }
};

const buildInstruction = (input: {
  interaction: ExecutionInteraction;
  parsed: ParsedInteractionPayload | null;
  resumeCommand: string;
}): string => {
  const reason = describePauseReason(input.interaction);
  const prompt = input.parsed?.message ?? "Interaction required";

  if (input.parsed?.mode === "url") {
    const url = input.parsed.url?.trim();
    return url && url.length > 0
      ? `Execution paused because ${reason}. Open ${url} and complete the requested flow for "${prompt}", then run ${input.resumeCommand} to continue if it does not resume automatically.`
      : `Execution paused because ${reason}. Run ${input.resumeCommand} to continue and complete the requested flow for "${prompt}".`;
  }

  if (input.parsed?.requestedSchema) {
    return `Execution paused because ${reason}. The interaction prompt is "${prompt}". Run ${input.resumeCommand} in an interactive terminal and respond with input matching interaction.requestedSchema.`;
  }

  return `Execution paused because ${reason}. The interaction prompt is "${prompt}". Run ${input.resumeCommand} in an interactive terminal to continue.`;
};

export const buildPausedExecutionOutput = (input: {
  executionId: string;
  interaction: ExecutionInteraction;
  baseUrl: string;
  shouldOpenUrls: boolean;
  cliName?: string;
}) => {
  const cliName = input.cliName ?? "executor";
  const argv = [cliName, "resume", "--execution-id", input.executionId, "--base-url", input.baseUrl];
  if (!input.shouldOpenUrls) {
    argv.push("--no-open");
  }

  const command = renderCommand(argv);
  const parsed = parseInteractionPayload(input.interaction);

  return {
    id: input.executionId,
    status: "waiting_for_interaction" as const,
    interactionId: input.interaction.id,
    message: parsed?.message ?? "Interaction required",
    resumeCommand: command,
    interaction: {
      id: input.interaction.id,
      purpose: input.interaction.purpose,
      mode: parsed?.mode ?? (input.interaction.kind === "url" ? "url" : "form"),
      message: parsed?.message ?? "Interaction required",
      url: parsed?.url ?? null,
      requestedSchema: parsed?.requestedSchema ?? null,
    },
    resume: {
      command,
      argv,
    },
    instruction: buildInstruction({
      interaction: input.interaction,
      parsed,
      resumeCommand: command,
    }),
  };
};

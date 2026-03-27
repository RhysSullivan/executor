import type {
  ElicitationResponse,
  OnElicitation,
  ToolElicitationRequest,
} from "@executor/codemode-core";
import * as Effect from "effect/Effect";

import type {
  InteractionRequest,
  OnInteraction,
  OnToolApproval,
  ToolApprovalRequest,
} from "./types";

const ACCEPT: ElicitationResponse = { action: "accept" };
const DECLINE: ElicitationResponse = { action: "decline" };

const extractToolApprovalRequest = (
  input: ToolElicitationRequest,
): ToolApprovalRequest => {
  const ctx = (input.context ?? {}) as Record<string, unknown>;
  const descriptor = (ctx.invocationDescriptor ?? {}) as Record<
    string,
    unknown
  >;

  return {
    toolPath: String(input.path),
    sourceId: String(descriptor.sourceId ?? input.sourceKey ?? ""),
    sourceName: String(descriptor.sourceName ?? ""),
    operationKind: (descriptor.operationKind as ToolApprovalRequest["operationKind"]) ?? "unknown",
    args: input.args,
    reason: String(ctx.interactionReason ?? "Approval required"),
    approvalLabel: typeof descriptor.approvalLabel === "string"
      ? descriptor.approvalLabel
      : null,
    context: ctx,
  };
};

const extractInteractionRequest = (
  input: ToolElicitationRequest,
): InteractionRequest => {
  const ctx = (input.context ?? {}) as Record<string, unknown>;

  if (input.elicitation.mode === "url") {
    return {
      kind: "url",
      url: input.elicitation.url,
      message: input.elicitation.message,
      sourceId: input.sourceKey || undefined,
      context: ctx,
    };
  }

  return {
    kind: "form",
    message: input.elicitation.message,
    requestedSchema: input.elicitation.requestedSchema,
    toolPath: String(input.path) || undefined,
    sourceId: input.sourceKey || undefined,
    context: ctx,
  };
};

const isToolExecutionGate = (input: ToolElicitationRequest): boolean => {
  const ctx = input.context as Record<string, unknown> | undefined;
  return ctx?.interactionPurpose === "tool_execution_gate";
};

export const createElicitationAdapter = (input: {
  onToolApproval?: OnToolApproval;
  onInteraction?: OnInteraction;
}): OnElicitation => {
  const { onToolApproval, onInteraction } = input;

  return (request: ToolElicitationRequest) =>
    Effect.gen(function* () {
      // --- Tool approval gate ---
      if (isToolExecutionGate(request)) {
        if (onToolApproval === "allow-all" || onToolApproval === undefined) {
          return ACCEPT;
        }
        if (onToolApproval === "deny-all") {
          return DECLINE;
        }

        const approvalRequest = extractToolApprovalRequest(request);
        const response = yield* Effect.tryPromise({
          try: () => Promise.resolve(onToolApproval(approvalRequest)),
          catch: (err) =>
            err instanceof Error ? err : new Error(String(err)),
        });

        return response.approved
          ? ACCEPT
          : { action: "decline" as const };
      }

      // --- URL and form interactions ---
      if (!onInteraction) {
        const mode = request.elicitation.mode ?? "form";
        return yield* Effect.fail(
          new Error(
            `An ${mode} interaction was requested (${request.elicitation.message}), ` +
              `but no onInteraction callback was provided`,
          ),
        );
      }

      const interactionRequest = extractInteractionRequest(request);
      const response = yield* Effect.tryPromise({
        try: () => Promise.resolve(onInteraction(interactionRequest)),
        catch: (err) =>
          err instanceof Error ? err : new Error(String(err)),
      });

      return {
        action: response.action,
        content: "content" in response ? response.content : undefined,
      } satisfies ElicitationResponse;
    });
};

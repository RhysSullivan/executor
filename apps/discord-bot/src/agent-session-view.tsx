import type { TurnResult } from "@openassistant/gateway/rpc";
import type { ButtonInteraction } from "discord.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalRequestView, AssistantReplyView, AssistantWorkingView } from "./discord-views.js";
import { formatDiscordResponse } from "./format-response.js";
import { continueGatewayTurn, resolveGatewayApproval, runGatewayTurn } from "./gateway-client.js";

type ApprovalState = NonNullable<TurnResult["approval"]>;

type SessionState =
  | { phase: "starting" }
  | {
      phase: "awaiting";
      turnId: string;
      approval: ApprovalState;
      resolving: boolean;
      resolved?: { decision: "approved" | "denied"; actorId?: string };
    }
  | { phase: "completed"; message: string; footer?: string }
  | { phase: "failed"; message: string };

export function AgentSessionView(params: {
  prompt: string;
  requesterId: string;
  channelId: string;
  approvalTimeoutMs: number;
}) {
  const { prompt, requesterId, channelId, approvalTimeoutMs } = params;
  const [state, setState] = useState<SessionState>({ phase: "starting" });
  const isMounted = useRef(true);

  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  const applyTurnResult = useCallback((turn: TurnResult) => {
    if (!isMounted.current) {
      return;
    }
    if (turn.status === "awaiting_approval") {
      if (!turn.approval) {
        setState({
          phase: "failed",
          message: "Approval was required but no approval payload was returned.",
        });
        return;
      }
      setState({
        phase: "awaiting",
        turnId: turn.turnId,
        approval: turn.approval,
        resolving: false,
      });
      return;
    }

    if (turn.status === "failed") {
      setState({
        phase: "failed",
        message: turn.error ? `I couldn't complete that request: ${turn.error}` : "I couldn't complete that request.",
      });
      return;
    }

    const response = formatDiscordResponse({
      text: turn.message ?? "",
      footer: turn.footer,
    });
    setState({
      phase: "completed",
      message: response.message,
      ...(response.footer ? { footer: response.footer } : {}),
    });
  }, []);

  const continueAfterDecision = useCallback(
    async (params: {
      turnId: string;
      callId: string;
      decision: "approved" | "denied";
      actorId: string;
    }) => {
      const { turnId, callId, decision, actorId } = params;
      setState((current) => {
        if (
          current.phase !== "awaiting" ||
          current.turnId !== turnId ||
          current.approval.callId !== callId
        ) {
          return current;
        }
        return {
          ...current,
          resolving: true,
          resolved: { decision, actorId },
        };
      });

      try {
        const resolved = await resolveGatewayApproval({
          turnId,
          callId,
          actorId,
          decision,
        });
        if (resolved.status !== "resolved") {
          if (!isMounted.current) {
            return;
          }
          setState({
            phase: "failed",
            message: `Approval could not be applied: ${resolved.status}.`,
          });
          return;
        }
        const next = await continueGatewayTurn(turnId);
        applyTurnResult(next);
      } catch (error) {
        if (!isMounted.current) {
          return;
        }
        setState({
          phase: "failed",
          message: `I hit an unexpected error while continuing this request: ${describeUnknown(error)}`,
        });
      }
    },
    [applyTurnResult],
  );

  useEffect(() => {
    void (async () => {
      try {
        const turn = await runGatewayTurn({
          prompt,
          requesterId,
          channelId,
        });
        applyTurnResult(turn);
      } catch (error) {
        if (!isMounted.current) {
          return;
        }
        setState({
          phase: "failed",
          message: `I hit an unexpected error while processing that request: ${describeUnknown(error)}`,
        });
      }
    })();
  }, [prompt, requesterId, channelId, applyTurnResult]);

  useEffect(() => {
    if (state.phase !== "awaiting" || state.resolving) {
      return;
    }
    const timer = setTimeout(() => {
      void continueAfterDecision({
        turnId: state.turnId,
        callId: state.approval.callId,
        decision: "denied",
        actorId: requesterId,
      });
    }, approvalTimeoutMs);

    return () => clearTimeout(timer);
  }, [approvalTimeoutMs, continueAfterDecision, requesterId, state]);

  if (state.phase === "starting") {
    return <AssistantWorkingView />;
  }

  if (state.phase === "failed") {
    return <AssistantReplyView message={state.message} />;
  }

  if (state.phase === "completed") {
    return <AssistantReplyView message={state.message} footer={state.footer} />;
  }

  return (
    <ApprovalRequestView
      toolPath={state.approval.toolPath}
      callId={state.approval.callId}
      inputPreview={state.approval.inputPreview}
      requesterId={requesterId}
      resolved={state.resolved}
      onApprove={async (interaction) => {
        await handleDecisionInteraction({
          interaction,
          requesterId,
          onAllowed: () =>
            continueAfterDecision({
              turnId: state.turnId,
              callId: state.approval.callId,
              decision: "approved",
              actorId: interaction.user.id,
            }),
        });
      }}
      onDeny={async (interaction) => {
        await handleDecisionInteraction({
          interaction,
          requesterId,
          onAllowed: () =>
            continueAfterDecision({
              turnId: state.turnId,
              callId: state.approval.callId,
              decision: "denied",
              actorId: interaction.user.id,
            }),
        });
      }}
    />
  );
}

async function handleDecisionInteraction(params: {
  interaction: ButtonInteraction;
  requesterId: string;
  onAllowed: () => Promise<void>;
}): Promise<void> {
  if (params.interaction.user.id !== params.requesterId) {
    await params.interaction.reply({
      content: "Only the requesting user can resolve this approval.",
      ephemeral: true,
    });
    return;
  }
  await params.onAllowed();
}

function describeUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

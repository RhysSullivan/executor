import {
  createCodeModeRunner,
  type ApprovalDecision,
  type ApprovalRequest,
  type ToolTree,
} from "@openassistant/core";
import type { AgentLoopResult } from "./agent-loop.js";
import { runAgentLoop } from "./agent-loop.js";
import { type TurnResult } from "./rpc.js";
import { Effect } from "effect";

type PendingApproval = {
  callId: string;
  toolPath: string;
  inputPreview?: string;
  resolve: (decision: ApprovalDecision) => void;
};

type TurnEvent = TurnResult;

type TurnSession = {
  id: string;
  requesterId: string;
  channelId: string;
  queue: TurnEvent[];
  waitingResolver: ((event: TurnEvent) => void) | null;
  pendingApproval: PendingApproval | null;
  approvalWaiters: Array<() => void>;
  completed: boolean;
};

export type ResolveApprovalStatus = "resolved" | "not_found" | "unauthorized";

export class TurnManager {
  private readonly sessions = new Map<string, TurnSession>();

  constructor(
    private readonly tools: ToolTree,
    private readonly verboseFooter: boolean,
  ) {}

  start(params: {
    prompt: string;
    requesterId: string;
    channelId: string;
    now: Date;
  }): string {
    const id = newTurnId();
    const session: TurnSession = {
      id,
      requesterId: params.requesterId,
      channelId: params.channelId,
      queue: [],
      waitingResolver: null,
      pendingApproval: null,
      approvalWaiters: [],
      completed: false,
    };
    this.sessions.set(id, session);
    this.runSession(session, params.prompt, params.now);
    return id;
  }

  async waitForNext(turnId: string): Promise<TurnEvent | null> {
    const session = this.sessions.get(turnId);
    if (!session) {
      return null;
    }
    if (session.queue.length > 0) {
      const next = session.queue.shift()!;
      this.cleanupIfTerminal(session, next);
      return next;
    }

    const event = await new Promise<TurnEvent>((resolve) => {
      session.waitingResolver = resolve;
    });
    this.cleanupIfTerminal(session, event);
    return event;
  }

  resolveApproval(params: {
    turnId: string;
    callId: string;
    actorId: string;
    decision: ApprovalDecision;
  }): ResolveApprovalStatus {
    const session = this.sessions.get(params.turnId);
    if (!session) {
      return "not_found";
    }
    if (session.requesterId !== params.actorId) {
      return "unauthorized";
    }
    if (!session.pendingApproval || session.pendingApproval.callId !== params.callId) {
      return "not_found";
    }

    const pending = session.pendingApproval;
    session.pendingApproval = null;
    pending.resolve(params.decision);
    const nextWaiter = session.approvalWaiters.shift();
    if (nextWaiter) {
      nextWaiter();
    }
    return "resolved";
  }

  private async runSession(session: TurnSession, prompt: string, now: Date): Promise<void> {
    try {
      const runner = createCodeModeRunner({
        tools: this.tools,
        requestApproval: (request) =>
          Effect.tryPromise({
            try: () => this.requestApproval(session, request),
            catch: (error) => error,
          }),
      });

      const generated = await runAgentLoop(
        prompt,
        (code) => Effect.runPromise(runner.run({ code })),
        { now },
      );

      this.emitEvent(session, toCompletedEvent(session.id, generated, this.verboseFooter));
    } catch (error) {
      this.emitEvent(session, {
        status: "failed",
        turnId: session.id,
        error: describeUnknown(error),
      });
    } finally {
      session.completed = true;
    }
  }

  private async requestApproval(session: TurnSession, request: ApprovalRequest): Promise<ApprovalDecision> {
    await this.waitForApprovalSlot(session);

    return new Promise<ApprovalDecision>((resolve) => {
      session.pendingApproval = {
        callId: request.callId,
        toolPath: request.toolPath,
        ...(request.inputPreview ? { inputPreview: request.inputPreview } : {}),
        resolve,
      };

      this.emitEvent(session, {
        status: "awaiting_approval",
        turnId: session.id,
        approval: {
          callId: request.callId,
          toolPath: request.toolPath,
          ...(request.inputPreview ? { inputPreview: request.inputPreview } : {}),
        },
      });
    });
  }

  private async waitForApprovalSlot(session: TurnSession): Promise<void> {
    while (session.pendingApproval) {
      await new Promise<void>((resolve) => {
        session.approvalWaiters.push(resolve);
      });
    }
  }

  private emitEvent(session: TurnSession, event: TurnEvent): void {
    if (session.waitingResolver) {
      const resolve = session.waitingResolver;
      session.waitingResolver = null;
      resolve(event);
      return;
    }
    session.queue.push(event);
  }

  private cleanupIfTerminal(session: TurnSession, event: TurnEvent): void {
    if ((event.status === "completed" || event.status === "failed") && session.completed) {
      this.sessions.delete(session.id);
    }
  }
}

function toCompletedEvent(turnId: string, generated: AgentLoopResult, includeFooter: boolean): TurnResult {
  return {
    status: "completed",
    turnId,
    message: generated.text,
    planner: generated.planner,
    codeRuns: generated.runs.length,
    ...(includeFooter ? { footer: generated.planner } : {}),
  };
}

function newTurnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function describeUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

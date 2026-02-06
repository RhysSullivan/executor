import type { ApprovalDecision } from "@openassistant/core";

type PendingApproval = {
  requesterId: string;
  resolve: (decision: ApprovalDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type ResolveApprovalResult = "resolved" | "not_found" | "unauthorized";

export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly timeoutMs: number = 5 * 60_000) {}

  open(callId: string, requesterId: string): Promise<ApprovalDecision> {
    if (this.pending.has(callId)) {
      throw new Error(`Approval already pending: ${callId}`);
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => {
        this.finish(callId, "denied");
      }, this.timeoutMs);

      this.pending.set(callId, {
        requesterId,
        resolve,
        timeout,
      });
    });
  }

  resolve(callId: string, actorId: string, decision: ApprovalDecision): ResolveApprovalResult {
    const entry = this.pending.get(callId);
    if (!entry) {
      return "not_found";
    }
    if (entry.requesterId !== actorId) {
      return "unauthorized";
    }

    this.finish(callId, decision);
    return "resolved";
  }

  cancel(callId: string, decision: ApprovalDecision = "denied"): void {
    if (!this.pending.has(callId)) {
      return;
    }
    this.finish(callId, decision);
  }

  size(): number {
    return this.pending.size;
  }

  private finish(callId: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(callId);
    if (!entry) {
      return;
    }
    this.pending.delete(callId);
    clearTimeout(entry.timeout);
    entry.resolve(decision);
  }
}

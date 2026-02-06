import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";

export class RunTurnInput extends Schema.Class<RunTurnInput>("RunTurnInput")({
  prompt: Schema.String,
  requesterId: Schema.String,
  channelId: Schema.String,
  nowIso: Schema.String,
}) {}

export class ContinueTurnInput extends Schema.Class<ContinueTurnInput>("ContinueTurnInput")({
  turnId: Schema.String,
}) {}

export class ResolveApprovalInput extends Schema.Class<ResolveApprovalInput>("ResolveApprovalInput")({
  turnId: Schema.String,
  callId: Schema.String,
  actorId: Schema.String,
  decision: Schema.Literal("approved", "denied"),
}) {}

export class ResolveApprovalOutput extends Schema.Class<ResolveApprovalOutput>("ResolveApprovalOutput")({
  status: Schema.Literal("resolved", "not_found", "unauthorized"),
}) {}

export class ApprovalPrompt extends Schema.Class<ApprovalPrompt>("ApprovalPrompt")({
  callId: Schema.String,
  toolPath: Schema.String,
  inputPreview: Schema.optional(Schema.String),
}) {}

export const TurnResultSchema = Schema.Struct({
  status: Schema.Literal("awaiting_approval", "completed", "failed"),
  turnId: Schema.String,
  approval: Schema.optional(ApprovalPrompt),
  message: Schema.optional(Schema.String),
  planner: Schema.optional(Schema.String),
  codeRuns: Schema.optional(Schema.Number),
  footer: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

export type TurnResult = Schema.Schema.Type<typeof TurnResultSchema>;

export class AgentRpcs extends RpcGroup.make(
  Rpc.make("RunTurn", {
    payload: RunTurnInput,
    success: TurnResultSchema,
    error: Schema.String,
  }),
  Rpc.make("ContinueTurn", {
    payload: ContinueTurnInput,
    success: TurnResultSchema,
    error: Schema.String,
  }),
  Rpc.make("ResolveApproval", {
    payload: ResolveApprovalInput,
    success: ResolveApprovalOutput,
    error: Schema.String,
  }),
) {}

import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";

export class RunTurnInput extends Schema.Class<RunTurnInput>("RunTurnInput")({
  prompt: Schema.String,
  requesterId: Schema.String,
  channelId: Schema.String,
  nowIso: Schema.String,
}) {}

export class RunTurnOutput extends Schema.Class<RunTurnOutput>("RunTurnOutput")({
  message: Schema.String,
  planner: Schema.String,
  codeRuns: Schema.Number,
  footer: Schema.optional(Schema.String),
}) {}

export class AgentRpcs extends RpcGroup.make(
  Rpc.make("RunTurn", {
    payload: RunTurnInput,
    success: RunTurnOutput,
    error: Schema.String,
  }),
) {}

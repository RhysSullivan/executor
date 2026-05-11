import { Effect, Schema } from "effect";

import { ToolId } from "./ids";

// ---------------------------------------------------------------------------
// Elicitation request — what a tool sends when it needs user input
// ---------------------------------------------------------------------------

/** Tool needs structured input from the user (render a form) */
export const FormElicitation = Schema.TaggedStruct("FormElicitation", {
  message: Schema.String,
  /** JSON Schema describing the fields to collect */
  requestedSchema: Schema.Record(Schema.String, Schema.Unknown),
});
export type FormElicitation = typeof FormElicitation.Type;

/** Tool needs the user to visit a URL (OAuth, approval page, etc.) */
export const UrlElicitation = Schema.TaggedStruct("UrlElicitation", {
  message: Schema.String,
  url: Schema.String,
  /** Unique ID so the host can correlate the callback */
  elicitationId: Schema.String,
});
export type UrlElicitation = typeof UrlElicitation.Type;

export type ElicitationRequest = FormElicitation | UrlElicitation;

// ---------------------------------------------------------------------------
// Elicitation response — what the host sends back
// ---------------------------------------------------------------------------

export const ElicitationAction = Schema.Literals(["accept", "decline", "cancel"]);
export type ElicitationAction = typeof ElicitationAction.Type;

export const ElicitationResponse = Schema.Struct({
  action: ElicitationAction,
  /** Present when action is "accept" — the data the user provided */
  content: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ElicitationResponse = typeof ElicitationResponse.Type;

// ---------------------------------------------------------------------------
// Elicitation handler — the host provides this to handle requests
// ---------------------------------------------------------------------------

export interface ElicitationContext {
  readonly toolId: ToolId;
  readonly args: unknown;
  readonly request: ElicitationRequest;
}

/**
 * A function the host provides to handle elicitation.
 * The SDK calls this when a tool suspends to ask for user input.
 * The host renders UI / prompts the user / does OAuth / etc.
 */
export type ElicitationHandler = (ctx: ElicitationContext) => Effect.Effect<ElicitationResponse>;

// ---------------------------------------------------------------------------
// Elicitation error — tool was declined or cancelled
// ---------------------------------------------------------------------------

export class ElicitationDeclinedError extends Schema.TaggedErrorClass<ElicitationDeclinedError>()(
  "ElicitationDeclinedError",
  {
    toolId: ToolId,
    action: Schema.Literals(["decline", "cancel"]),
  },
) {}

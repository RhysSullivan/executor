import { Effect, Schema } from "effect";

import { ToolId } from "./ids";

// ---------------------------------------------------------------------------
// Elicitation request — what a tool sends when it needs user input
// ---------------------------------------------------------------------------

/** Tool needs structured input from the user (render a form) */
export class FormElicitation extends Schema.TaggedClass<FormElicitation>()(
  "FormElicitation",
  {
    message: Schema.String,
    /** JSON Schema describing the fields to collect */
    requestedSchema: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  },
) {}

/** Tool needs the user to visit a URL (OAuth, approval page, etc.) */
export class UrlElicitation extends Schema.TaggedClass<UrlElicitation>()(
  "UrlElicitation",
  {
    message: Schema.String,
    url: Schema.String,
    /** Unique ID so the host can correlate the callback */
    elicitationId: Schema.String,
  },
) {}

export type ElicitationRequest = FormElicitation | UrlElicitation;

// ---------------------------------------------------------------------------
// Elicitation response — what the host sends back
// ---------------------------------------------------------------------------

export const ElicitationAction = Schema.Literal("accept", "decline", "cancel");
export type ElicitationAction = typeof ElicitationAction.Type;

export class ElicitationResponse extends Schema.Class<ElicitationResponse>(
  "ElicitationResponse",
)({
  action: ElicitationAction,
  /** Present when action is "accept" — the data the user provided */
  content: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
}) {}

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
export type ElicitationHandler = (
  ctx: ElicitationContext,
) => Effect.Effect<ElicitationResponse>;

// ---------------------------------------------------------------------------
// Elicitation error — tool was declined or cancelled
// ---------------------------------------------------------------------------

export class ElicitationDeclinedError extends Schema.TaggedError<ElicitationDeclinedError>()(
  "ElicitationDeclinedError",
  {
    toolId: ToolId,
    action: Schema.Literal("decline", "cancel"),
  },
) {}

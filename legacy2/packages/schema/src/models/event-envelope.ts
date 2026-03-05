import { Schema } from "effect";

import { SchemaVersionSchema, TimestampMsSchema } from "../common";
import { EventIdSchema, WorkspaceIdSchema } from "../ids";

export const EventEnvelopeSchema = Schema.Struct({
  id: EventIdSchema,
  workspaceId: WorkspaceIdSchema,
  sequence: Schema.Number,
  schemaVersion: SchemaVersionSchema,
  eventType: Schema.String,
  payloadJson: Schema.String,
  createdAt: TimestampMsSchema,
});

export type EventEnvelope = typeof EventEnvelopeSchema.Type;

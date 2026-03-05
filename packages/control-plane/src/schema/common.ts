import { Schema } from "effect";

export const TimestampMsSchema = Schema.Number;

export type TimestampMs = typeof TimestampMsSchema.Type;

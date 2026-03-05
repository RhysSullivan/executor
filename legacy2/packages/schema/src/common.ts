import { Schema } from "effect";

export const SchemaVersionSchema = Schema.Number;
export const TimestampMsSchema = Schema.Number;
export const JsonStringSchema = Schema.String;

export type SchemaVersion = typeof SchemaVersionSchema.Type;
export type TimestampMs = typeof TimestampMsSchema.Type;

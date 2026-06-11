// ---------------------------------------------------------------------------
// ToolResult — typed value-based discriminated union returned by tool
// handlers and `invokeTool`. Domain success and expected failure both
// resolve through Effect's success channel; only true infra defects use
// the Effect failure channel.
// ---------------------------------------------------------------------------

import { Schema } from "effect";

export const ToolErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  details: Schema.optional(Schema.Unknown),
  retryable: Schema.optional(Schema.Boolean),
});

export type ToolError = typeof ToolErrorSchema.Type;

export const ToolHttpMetaSchema = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
});

/**
 * Transport metadata for HTTP-backed tools (OpenAPI). Kept beside `data`
 * rather than wrapped around it: `data` stays the upstream payload, while
 * cross-cutting transport facts (pagination Link headers, rate-limit
 * headers) remain reachable for callers that need them.
 */
export type ToolHttpMeta = typeof ToolHttpMetaSchema.Type;

export type ToolResult<T> =
  | { readonly ok: true; readonly data: T; readonly http?: ToolHttpMeta }
  | { readonly ok: false; readonly error: ToolError };

export const ToolResult = {
  ok: <T>(data: T, meta?: { readonly http?: ToolHttpMeta }): ToolResult<T> => ({
    ok: true,
    data,
    ...(meta?.http ? { http: meta.http } : {}),
  }),
  fail: <T = never>(error: ToolError): ToolResult<T> => ({ ok: false, error }),
} as const;

const ToolResultSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Unknown,
    http: Schema.optional(ToolHttpMetaSchema),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: ToolErrorSchema }),
]);

const isUnknownToolResult = Schema.is(ToolResultSchema);

export const isToolResult = (value: unknown): value is ToolResult<unknown> =>
  isUnknownToolResult(value);

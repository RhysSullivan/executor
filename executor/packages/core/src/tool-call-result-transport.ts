import { z } from "zod";
import type { ToolCallResult } from "./types";

const UNDEFINED_SENTINEL = "__executor_tool_result_undefined__";

type ToolCallTransportResult =
  | { ok: true; valueJson: string }
  | {
      ok: false;
      kind: "pending";
      approvalId: string;
      retryAfterMs?: number;
      error?: string;
    }
  | { ok: false; kind: "denied"; error: string }
  | { ok: false; kind: "failed"; error: string };

const toolCallTransportResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    valueJson: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.literal("pending"),
    approvalId: z.string(),
    retryAfterMs: z.number().optional(),
    error: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.literal("denied"),
    error: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.literal("failed"),
    error: z.string(),
  }),
]);

function encodeValue(value: unknown): string {
  if (value === undefined) {
    return UNDEFINED_SENTINEL;
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return UNDEFINED_SENTINEL;
    }
    return serialized;
  } catch {
    return JSON.stringify(String(value));
  }
}

function decodeValue(valueJson: string): unknown {
  if (valueJson === UNDEFINED_SENTINEL) {
    return undefined;
  }

  try {
    return JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
}

export function encodeToolCallResultForTransport(result: ToolCallResult): string {
  const transportResult: ToolCallTransportResult = result.ok
    ? { ok: true, valueJson: encodeValue(result.value) }
    : result;

  return JSON.stringify(transportResult);
}

export function decodeToolCallResultFromTransport(value: unknown): ToolCallResult | null {
  const parsedJson: unknown = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      })()
    : value;

  const parsed = toolCallTransportResultSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }

  const record = parsed.data;
  if (record.ok) {
    return {
      ok: true,
      value: decodeValue(record.valueJson),
    };
  }

  if (record.kind === "pending") {
    return {
      ok: false,
      kind: "pending",
      approvalId: record.approvalId,
      ...(record.retryAfterMs !== undefined ? { retryAfterMs: record.retryAfterMs } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }

  if (record.kind === "denied") {
    return {
      ok: false,
      kind: "denied",
      error: record.error,
    };
  }

  if (record.kind === "failed") {
    return {
      ok: false,
      kind: "failed",
      error: record.error,
    };
  }

  return null;
}

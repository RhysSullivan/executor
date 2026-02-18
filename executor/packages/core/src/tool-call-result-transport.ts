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
  const parsed: unknown = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      })()
    : value;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.ok === true) {
    if (typeof record.valueJson !== "string") {
      return null;
    }
    return {
      ok: true,
      value: decodeValue(record.valueJson),
    };
  }

  if (record.ok === false && record.kind === "pending" && typeof record.approvalId === "string") {
    return {
      ok: false,
      kind: "pending",
      approvalId: record.approvalId,
      ...(typeof record.retryAfterMs === "number" ? { retryAfterMs: record.retryAfterMs } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {}),
    };
  }

  if (record.ok === false && record.kind === "denied" && typeof record.error === "string") {
    return {
      ok: false,
      kind: "denied",
      error: record.error,
    };
  }

  if (record.ok === false && record.kind === "failed" && typeof record.error === "string") {
    return {
      ok: false,
      kind: "failed",
      error: record.error,
    };
  }

  return null;
}

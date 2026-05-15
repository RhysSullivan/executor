// ---------------------------------------------------------------------------
// ToolResult — typed value-based discriminated union returned by tool
// handlers and `invokeTool`. Domain success and expected failure both
// resolve through Effect's success channel; only true infra defects use
// the Effect failure channel.
// ---------------------------------------------------------------------------

export interface ToolError {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly details?: unknown;
  readonly retryable?: boolean;
}

export type ToolResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ToolError };

export const ToolResult = {
  ok: <T>(data: T): ToolResult<T> => ({ ok: true, data }),
  fail: <T = never>(error: ToolError): ToolResult<T> => ({ ok: false, error }),
} as const;

export const isToolResult = (value: unknown): value is ToolResult<unknown> => {
  if (value === null || typeof value !== "object") return false;
  if (!("ok" in value)) return false;
  const ok = (value as { ok: unknown }).ok;
  if (ok === true) return "data" in value;
  if (ok === false) {
    if (!("error" in value)) return false;
    const error = (value as { error: unknown }).error;
    if (error === null || typeof error !== "object") return false;
    if (!("code" in error) || !("message" in error)) return false;
    const errorObj = error as { readonly code: unknown; readonly message: unknown };
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: structural type guard; `message` is a required ToolError field, not a thrown JS error
    return typeof errorObj.code === "string" && typeof errorObj.message === "string";
  }
  return false;
};

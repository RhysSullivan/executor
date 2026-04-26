// ---------------------------------------------------------------------------
// Opaque cursor helpers for ExecutionStore.list pagination.
//
// Cursors encode `{ createdAt, id }` — the tuple adapter backends need to
// resume a scan on `ORDER BY created_at DESC, id DESC`. Encoded as
// url-safe base64 so callers can pass them through query params without
// thinking about escaping.
// ---------------------------------------------------------------------------

export interface CursorPayload {
  readonly createdAt: number;
  readonly id: string;
}

const toBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): string => {
  const pad = value.length % 4 === 0 ? 0 : 4 - (value.length % 4);
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

export const encodeCursor = (payload: CursorPayload): string =>
  toBase64Url(JSON.stringify(payload));

export const decodeCursor = (raw: string): CursorPayload | null => {
  try {
    const parsed = JSON.parse(fromBase64Url(raw)) as Record<string, unknown>;
    if (typeof parsed.createdAt !== "number" || typeof parsed.id !== "string") {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
};

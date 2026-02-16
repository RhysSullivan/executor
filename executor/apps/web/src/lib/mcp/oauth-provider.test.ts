import { expect, test } from "bun:test";
import {
  decodePendingCookieValue,
  decodePopupResultCookieValue,
  encodePendingCookieValue,
  encodePopupResultCookieValue,
  type McpOAuthPending,
  type McpOAuthPopupResult,
} from "./oauth-provider";

test("pending cookie round-trips with versioned envelope", () => {
  const pending: McpOAuthPending = {
    state: "state-123",
    sourceUrl: "https://example.com/mcp",
    redirectUrl: "https://app.example.com/oauth/callback",
    codeVerifier: "verifier-123",
  };

  const encoded = encodePendingCookieValue(pending);
  expect(decodePendingCookieValue(encoded)).toEqual(pending);
});

test("pending cookie decoder rejects unversioned payloads", () => {
  const unversionedPayload = {
    state: "legacy-state",
    sourceUrl: "https://legacy.example.com/mcp",
    redirectUrl: "https://legacy.example.com/callback",
  };
  const raw = Buffer.from(JSON.stringify(unversionedPayload), "utf8").toString("base64url");

  expect(decodePendingCookieValue(raw)).toBeNull();
});

test("popup cookie round-trips with versioned envelope", () => {
  const result: McpOAuthPopupResult = {
    ok: true,
    sourceUrl: "https://example.com/mcp",
    accessToken: "token-123",
    refreshToken: "refresh-123",
    scope: "read write",
    expiresIn: 3600,
  };

  const encoded = encodePopupResultCookieValue(result);
  expect(decodePopupResultCookieValue(encoded)).toEqual(result);
});

test("popup cookie decoder rejects invalid payloads", () => {
  const invalidRaw = Buffer.from(JSON.stringify({ ok: "yes" }), "utf8").toString("base64url");
  expect(decodePopupResultCookieValue(invalidRaw)).toBeNull();
});

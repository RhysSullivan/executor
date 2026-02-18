import { expect, test } from "bun:test";
import {
  decodeToolCallResultFromTransport,
  encodeToolCallResultForTransport,
} from "./tool-call-result-transport";

test("tool call transport preserves $-prefixed keys in success payloads", () => {
  const encoded = encodeToolCallResultForTransport({
    ok: true,
    value: {
      schema: {
        $ref: "#/components/schemas/Thing",
      },
    },
  });

  const decoded = decodeToolCallResultFromTransport(encoded);
  expect(decoded).toEqual({
    ok: true,
    value: {
      schema: {
        $ref: "#/components/schemas/Thing",
      },
    },
  });
});

test("tool call transport preserves pending failures", () => {
  const encoded = encodeToolCallResultForTransport({
    ok: false,
    kind: "pending",
    approvalId: "ap_123",
    retryAfterMs: 500,
    error: "Approval pending",
  });

  const decoded = decodeToolCallResultFromTransport(encoded);
  expect(decoded).toEqual({
    ok: false,
    kind: "pending",
    approvalId: "ap_123",
    retryAfterMs: 500,
    error: "Approval pending",
  });
});

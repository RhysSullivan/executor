import {
  describe,
  expect,
  it,
} from "@effect/vitest";

import {
  sanitizePersistedElicitationResponse,
} from "./live";

describe("live-execution", () => {
  it("redacts secret refs from persisted interaction responses", () => {
    const sanitized = sanitizePersistedElicitationResponse({
      action: "accept",
      content: {
        authKind: "bearer",
        tokenSecretRef: {
          secretId: "sec_123",
        },
      },
    });

    expect(sanitized).toEqual({
      action: "accept",
      content: {
        authKind: "bearer",
      },
    });
  });

  it("keeps unrelated interaction response content intact", () => {
    const sanitized = sanitizePersistedElicitationResponse({
      action: "cancel",
      content: {
        reason: "User declined",
        nested: {
          keep: true,
        },
      },
    });

    expect(sanitized).toEqual({
      action: "cancel",
      content: {
        reason: "User declined",
        nested: {
          keep: true,
        },
      },
    });
  });
});

import { describe, expect, it } from "@effect/vitest";

import { SetupStatusError, fetchNeedsSetup } from "../web/setup-status";

describe("fetchNeedsSetup", () => {
  it("returns false when the server says setup is complete", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ needsSetup: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      await expect(fetchNeedsSetup()).resolves.toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries failed setup checks before surfacing an error", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    try {
      await expect(fetchNeedsSetup()).rejects.toBeInstanceOf(SetupStatusError);
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

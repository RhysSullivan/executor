import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect } from "effect";

import { isReachable, pollReadiness } from "./readiness";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isReachable", () => {
  it.effect("returns true when fetch resolves with ok true", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
      );

      const reachable = yield* isReachable("http://127.0.0.1:4788/api/scope");

      expect(reachable).toBe(true);
    }),
  );

  it.effect("returns false when fetch rejects", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new Error("connection refused"))),
      );

      const reachable = yield* isReachable("http://127.0.0.1:4788/api/scope");

      expect(reachable).toBe(false);
    }),
  );

  it.effect("returns false when response is not ok", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
      );

      const reachable = yield* isReachable("http://127.0.0.1:4788/api/scope");

      expect(reachable).toBe(false);
    }),
  );

  it.effect("honors probeTimeoutMs", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_: string, init?: RequestInit) =>
            new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        ),
      );

      const reachable = yield* isReachable("http://127.0.0.1:4788/api/scope", {
        probeTimeoutMs: 1,
      });

      expect(reachable).toBe(false);
    }),
  );
});

describe("pollReadiness", () => {
  it.effect("returns immediately when already reachable", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
      vi.stubGlobal("fetch", fetchMock);

      yield* pollReadiness("http://127.0.0.1:4788/api/scope", {
        timeoutMs: 50,
        intervalMs: 1,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("retries until reachable", () =>
    Effect.gen(function* () {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          calls += 1;
          return Promise.resolve(new Response(null, { status: calls >= 3 ? 204 : 503 }));
        }),
      );

      yield* pollReadiness("http://127.0.0.1:4788/api/scope", {
        timeoutMs: 100,
        intervalMs: 1,
      });

      expect(calls).toBe(3);
    }),
  );

  it.effect("fails with ReadinessTimeout after timeout", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
      );

      const error = yield* Effect.flip(
        pollReadiness("http://127.0.0.1:4788/api/scope", {
          timeoutMs: 3,
          intervalMs: 1,
        }),
      );

      expect(error._tag).toBe("ReadinessTimeout");
      expect(error.url).toBe("http://127.0.0.1:4788/api/scope");
      expect(error.attempts).toBeGreaterThan(0);
    }),
  );
});

import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { createExecutor, makeTestConfig, SecretId } from "@executor/sdk";
import { keychainPlugin } from "./index";

describe("keychain plugin", () => {
  it.effect("registers keychain as a secret provider", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [keychainPlugin()] as const,
        }),
      );

      expect(executor.keychain.displayName).toBeTypeOf("string");
      expect(executor.keychain.isSupported).toBeTypeOf("boolean");

      const providers = yield* executor.secrets.providers();
      expect(providers).toContain("keychain");
    }),
  );

  // The tests below exercise the real system keychain.
  // Run manually on a supported platform.

  it.effect("stores and checks secret via system keychain", () =>
    Effect.gen(function* () {
      const testId = SecretId.make(`test-keychain-${Date.now()}`);
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            keychainPlugin({ serviceName: "executor-test" }),
          ] as const,
        }),
      );

      try {
        // Store through SDK, pinned to keychain provider
        yield* executor.secrets.set({
          id: testId,
          name: "Test Secret",
          value: "keychain-test-value",
          provider: "keychain",
        });

        // Plugin can check if it exists in the keychain
        const exists = yield* executor.keychain.has(testId);
        expect(exists).toBe(true);

        // SDK resolves through provider chain
        const resolved = yield* executor.secrets.resolve(testId);
        expect(resolved).toBe("keychain-test-value");
      } finally {
        yield* executor.secrets.remove(testId).pipe(
          Effect.orElseSucceed(() => false),
        );
      }
    }),
  );

  it.effect("has returns false for missing secret", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            keychainPlugin({ serviceName: "executor-test" }),
          ] as const,
        }),
      );

      const exists = yield* executor.keychain.has(
        SecretId.make("nonexistent-secret"),
      );
      expect(exists).toBe(false);
    }),
  );
});

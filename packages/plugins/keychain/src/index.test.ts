import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import {
  ScopeId,
  SecretId,
  SetSecretInput,
  createExecutor,
  makeTestConfig,
} from "@executor/sdk";
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
  // They are skipped in CI because there is no keychain service available.

  it.effect.skipIf(!!process.env.CI)("stores and checks secret via system keychain", () =>
    Effect.gen(function* () {
      const testId = SecretId.make(`test-keychain-${Date.now()}`);
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [keychainPlugin({ serviceName: "executor-test" })] as const,
        }),
      );

      try {
        // Store through SDK, pinned to keychain provider
        yield* executor.secrets.set(
          new SetSecretInput({
            id: testId,
            scope: ScopeId.make("test-scope"),
            name: "Test Secret",
            value: "keychain-test-value",
            provider: "keychain",
          }),
        );

        // Plugin can check if it exists in the keychain
        const exists = yield* executor.keychain.has(testId);
        expect(exists).toBe(true);

        // SDK routes through the core secret table → pinned provider
        const resolved = yield* executor.secrets.get(testId);
        expect(resolved).toBe("keychain-test-value");
      } finally {
        yield* executor.secrets.remove(testId).pipe(Effect.orElseSucceed(() => undefined));
      }
    }),
  );

  it.effect.skipIf(!!process.env.CI)("has returns false for missing secret", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [keychainPlugin({ serviceName: "executor-test" })] as const,
        }),
      );

      const exists = yield* executor.keychain.has("nonexistent-secret");
      expect(exists).toBe(false);
    }),
  );
});

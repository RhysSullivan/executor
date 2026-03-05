import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  SecretNotFoundError,
  makeInMemorySecretProvider,
  makeSecretStore,
} from "./secret-store";

describe("secret store", () => {
  it.effect("supports mix-and-match providers via handles", () =>
    Effect.gen(function* () {
      const store = makeSecretStore({
        providers: [
          makeInMemorySecretProvider("keychain"),
          makeInMemorySecretProvider("onepassword"),
        ],
        defaultProviderId: "keychain",
      });

      const h1 = yield* store.put({
        key: "github-token",
        value: "token-1",
      });

      const h2 = yield* store.put({
        providerId: "onepassword",
        key: "stripe-key",
        value: "token-2",
      });

      const v1 = yield* store.get(h1);
      const v2 = yield* store.get(h2);

      expect(h1.startsWith("keychain:")).toBe(true);
      expect(h2.startsWith("onepassword:")).toBe(true);
      expect(v1).toBe("token-1");
      expect(v2).toBe("token-2");
    }),
  );

  it.effect("returns not found after delete", () =>
    Effect.gen(function* () {
      const store = makeSecretStore({
        providers: [makeInMemorySecretProvider("keychain")],
        defaultProviderId: "keychain",
      });

      const handle = yield* store.put({
        key: "api-key",
        value: "abc",
      });

      yield* store.delete(handle);

      const result = yield* Effect.either(store.get(handle));
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(SecretNotFoundError);
      }
    }),
  );
});

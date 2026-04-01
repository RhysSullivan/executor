// ---------------------------------------------------------------------------
// KV-backed SecretStore — stores refs only, never secret values
// ---------------------------------------------------------------------------

import { Effect, Option, Schema } from "effect";

import { SecretRef, SecretId, ScopeId } from "@executor/sdk";
import { SecretNotFoundError, SecretResolutionError } from "@executor/sdk";
import type { SecretProvider, ScopedKv, SetSecretInput } from "@executor/sdk";

// ---------------------------------------------------------------------------
// Serialization — leverage SecretRef Schema.Class directly
// ---------------------------------------------------------------------------

const RefJson = Schema.parseJson(SecretRef);
const encodeRef = Schema.encodeSync(RefJson);
const decodeRef = Schema.decodeUnknownSync(RefJson);

// ---------------------------------------------------------------------------
// Factory — no default provider, host must add them
// ---------------------------------------------------------------------------

export const makeKvSecretStore = (refsKv: ScopedKv) => {
  const providers: SecretProvider[] = [];

  const findWritableProvider = (key?: string): SecretProvider | undefined =>
    key ? providers.find((p) => p.key === key) : providers.find((p) => p.writable);

  const resolveFromProviders = (
    secretId: SecretId,
    providerKey: string | undefined,
  ): Effect.Effect<string | null> => {
    if (providerKey) {
      const provider = providers.find((p) => p.key === providerKey);
      return provider ? provider.get(secretId) : Effect.succeed(null);
    }
    return Effect.gen(function* () {
      for (const provider of providers) {
        const value = yield* provider.get(secretId);
        if (value !== null) return value;
      }
      return null;
    });
  };

  return {
    list: (scopeId: ScopeId) =>
      Effect.gen(function* () {
        const entries = yield* refsKv.list();
        return entries
          .map((e) => decodeRef(e.value))
          .filter((r) => r.scopeId === scopeId);
      }),

    get: (secretId: SecretId) =>
      Effect.gen(function* () {
        const raw = yield* refsKv.get(secretId);
        if (!raw) return yield* new SecretNotFoundError({ secretId });
        return decodeRef(raw);
      }),

    resolve: (secretId: SecretId, _scopeId: ScopeId) =>
      Effect.gen(function* () {
        const raw = yield* refsKv.get(secretId);
        const providerKey = raw
          ? Option.getOrUndefined(decodeRef(raw).provider)
          : undefined;
        const value = yield* resolveFromProviders(secretId, providerKey);
        if (value === null) {
          return yield* new SecretResolutionError({
            secretId,
            message: `Secret "${secretId}" not found in any provider`,
          });
        }
        return value;
      }),

    status: (secretId: SecretId, _scopeId: ScopeId) =>
      Effect.gen(function* () {
        const value = yield* resolveFromProviders(secretId, undefined);
        return value !== null ? ("resolved" as const) : ("missing" as const);
      }),

    set: (input: SetSecretInput) =>
      Effect.gen(function* () {
        const provider = findWritableProvider(input.provider);
        if (!provider?.set) {
          return yield* new SecretResolutionError({
            secretId: input.id,
            message: `No writable provider found${input.provider ? ` (requested: ${input.provider})` : ""}`,
          });
        }

        yield* provider.set(input.id, input.value);

        const ref = new SecretRef({
          id: input.id,
          scopeId: input.scopeId,
          name: input.name,
          provider: Option.fromNullable(input.provider),
          purpose: input.purpose,
          createdAt: new Date(),
        });

        yield* refsKv.set(input.id, encodeRef(ref));
        return ref;
      }),

    remove: (secretId: SecretId) =>
      Effect.gen(function* () {
        const raw = yield* refsKv.get(secretId);
        if (!raw) return yield* new SecretNotFoundError({ secretId });
        const ref = decodeRef(raw);

        const providerKey = Option.getOrUndefined(ref.provider);
        const provider = findWritableProvider(providerKey);
        if (provider?.delete) yield* provider.delete(secretId);

        yield* refsKv.delete(secretId);
        return true;
      }),

    addProvider: (provider: SecretProvider) =>
      Effect.sync(() => { providers.push(provider); }),

    providers: () => Effect.sync(() => providers.map((p) => p.key)),
  };
};

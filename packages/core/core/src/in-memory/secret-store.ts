import { Effect, Option } from "effect";

import { ScopeId, SecretId } from "../ids";
import { SecretNotFoundError, SecretResolutionError } from "../errors";
import type { SecretRef, SecretProvider, SetSecretInput } from "../secrets";

// ---------------------------------------------------------------------------
// In-memory secret provider
// ---------------------------------------------------------------------------

export const makeInMemorySecretProvider = (): SecretProvider => {
  const values = new Map<string, string>();
  return {
    key: "memory",
    writable: true,
    get: (key) => Effect.sync(() => values.get(key) ?? null),
    set: (key, value) => Effect.sync(() => { values.set(key, value); }),
    delete: (key) => Effect.sync(() => values.delete(key)),
    list: () => Effect.sync(() => [...values.keys()].map((k) => ({ id: k, name: k }))),
  };
};

// ---------------------------------------------------------------------------
// In-memory secret store
// ---------------------------------------------------------------------------

export const makeInMemorySecretStore = () => {
  const refs = new Map<string, SecretRef>();
  const providers: SecretProvider[] = [];

  // Add a default in-memory provider
  const defaultProvider = makeInMemorySecretProvider();
  providers.push(defaultProvider);

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
    // Try all providers in order
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
      Effect.sync(() =>
        [...refs.values()].filter((r) => r.scopeId === scopeId),
      ),

    get: (secretId: SecretId) =>
      Effect.fromNullable(refs.get(secretId)).pipe(
        Effect.mapError(() => new SecretNotFoundError({ secretId })),
      ),

    resolve: (secretId: SecretId, _scopeId: ScopeId) =>
      Effect.gen(function* () {
        const ref = refs.get(secretId);
        const providerKey = ref ? Option.getOrUndefined(ref.provider) : undefined;

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

        const ref: SecretRef = {
          id: input.id,
          scopeId: input.scopeId,
          name: input.name,
          provider: Option.fromNullable(input.provider),
          purpose: input.purpose,
          createdAt: new Date(),
        };
        refs.set(input.id, ref);
        return ref;
      }),

    remove: (secretId: SecretId) =>
      Effect.gen(function* () {
        const ref = refs.get(secretId);
        if (!ref) return yield* new SecretNotFoundError({ secretId });

        const providerKey = Option.getOrUndefined(ref.provider);
        const provider = findWritableProvider(providerKey);
        if (provider?.delete) {
          yield* provider.delete(secretId);
        }

        refs.delete(secretId);
        return true;
      }),

    addProvider: (provider: SecretProvider) =>
      Effect.sync(() => { providers.push(provider); }),

    providers: () =>
      Effect.sync(() => providers.map((p) => p.key)),
  };
};

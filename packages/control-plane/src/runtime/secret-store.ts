import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class SecretProviderNotFoundError extends Data.TaggedError(
  "SecretProviderNotFoundError",
)<{
  providerId: string;
}> {}

export class SecretNotFoundError extends Data.TaggedError(
  "SecretNotFoundError",
)<{
  providerId: string;
  key: string;
}> {}

export class SecretProviderError extends Data.TaggedError(
  "SecretProviderError",
)<{
  providerId: string;
  operation: "put" | "get" | "delete";
  message: string;
}> {}

export type SecretRecord = {
  value: string;
  updatedAt: number;
};

export type SecretProvider = {
  providerId: string;
  put: (key: string, value: string) => Effect.Effect<void, SecretProviderError>;
  get: (key: string) => Effect.Effect<string, SecretProviderError | SecretNotFoundError>;
  delete: (key: string) => Effect.Effect<void, SecretProviderError>;
};

export type SecretHandle = `${string}:${string}`;

export type SecretStore = {
  put: (input: {
    key: string;
    value: string;
    providerId?: string;
  }) => Effect.Effect<SecretHandle, SecretProviderError | SecretProviderNotFoundError>;
  get: (
    handle: SecretHandle,
  ) => Effect.Effect<string, SecretProviderError | SecretProviderNotFoundError | SecretNotFoundError>;
  delete: (
    handle: SecretHandle,
  ) => Effect.Effect<void, SecretProviderError | SecretProviderNotFoundError>;
};

const encodeSecretHandle = (providerId: string, key: string): SecretHandle =>
  `${providerId}:${key}`;

const decodeSecretHandle = (
  handle: SecretHandle,
): { providerId: string; key: string } => {
  const index = handle.indexOf(":");
  if (index <= 0 || index === handle.length - 1) {
    return {
      providerId: "",
      key: "",
    };
  }

  return {
    providerId: handle.slice(0, index),
    key: handle.slice(index + 1),
  };
};

const lookupProvider = (
  providers: ReadonlyMap<string, SecretProvider>,
  providerId: string,
): Effect.Effect<SecretProvider, SecretProviderNotFoundError> => {
  const provider = providers.get(providerId);
  if (!provider) {
    return Effect.fail(new SecretProviderNotFoundError({ providerId }));
  }

  return Effect.succeed(provider);
};

export const makeInMemorySecretProvider = (providerId: string): SecretProvider => {
  const store = new Map<string, SecretRecord>();

  return {
    providerId,

    put: (key, value) =>
      Effect.sync(() => {
        store.set(key, {
          value,
          updatedAt: Date.now(),
        });
      }),

    get: (key) => {
      const entry = store.get(key);
      if (!entry) {
        return Effect.fail(
          new SecretNotFoundError({
            providerId,
            key,
          }),
        );
      }

      return Effect.succeed(entry.value);
    },

    delete: (key) =>
      Effect.sync(() => {
        store.delete(key);
      }),
  };
};

export const makeSecretStore = (input: {
  providers: ReadonlyArray<SecretProvider>;
  defaultProviderId: string;
}): SecretStore => {
  const providers = new Map(input.providers.map((provider) => [provider.providerId, provider]));

  return {
    put: ({ key, value, providerId }) =>
      Effect.gen(function* () {
        const selected = providerId ?? input.defaultProviderId;
        const provider = yield* lookupProvider(providers, selected);
        yield* provider.put(key, value);

        return encodeSecretHandle(provider.providerId, key);
      }),

    get: (handle) =>
      Effect.gen(function* () {
        const decoded = decodeSecretHandle(handle);
        if (decoded.providerId.length === 0 || decoded.key.length === 0) {
          return yield* Effect.fail(
            new SecretProviderError({
              providerId: "unknown",
              operation: "get",
              message: `Invalid secret handle: ${handle}`,
            }),
          );
        }

        const provider = yield* lookupProvider(providers, decoded.providerId);
        return yield* provider.get(decoded.key);
      }),

    delete: (handle) =>
      Effect.gen(function* () {
        const decoded = decodeSecretHandle(handle);
        if (decoded.providerId.length === 0 || decoded.key.length === 0) {
          return yield* Effect.fail(
            new SecretProviderError({
              providerId: "unknown",
              operation: "delete",
              message: `Invalid secret handle: ${handle}`,
            }),
          );
        }

        const provider = yield* lookupProvider(providers, decoded.providerId);
        yield* provider.delete(decoded.key);
      }),
  };
};

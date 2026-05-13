import { Effect, Schema } from "effect";

export const SecretBackedValue = Schema.Union([
  Schema.String,
  Schema.Struct({
    secretId: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
]);
export type SecretBackedValue = typeof SecretBackedValue.Type;

export const SecretBackedMap = Schema.Record(Schema.String, SecretBackedValue);
export type SecretBackedMap = typeof SecretBackedMap.Type;

export const isSecretBackedRef = (
  value: SecretBackedValue,
): value is Extract<SecretBackedValue, { readonly secretId: string }> => typeof value !== "string";

export type ResolveSecretBackedMapOptions<E, E2> = {
  readonly values: Record<string, SecretBackedValue> | undefined;
  readonly getSecret: (secretId: string) => Effect.Effect<string | null, E>;
  readonly onMissing: (
    name: string,
    value: Extract<SecretBackedValue, { readonly secretId: string }>,
  ) => E2;
  readonly onError?: (
    error: E,
    name: string,
    value: Extract<SecretBackedValue, { readonly secretId: string }>,
  ) => E | E2;
  readonly missing?: "fail" | "drop";
};

export const resolveSecretBackedMap = <E, E2 = E>({
  values,
  getSecret,
  onMissing,
  onError,
  missing = "fail",
}: ResolveSecretBackedMapOptions<E, E2>): Effect.Effect<
  Record<string, string> | undefined,
  E | E2
> => {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return Effect.succeed(undefined);

  return Effect.gen(function* () {
    const resolved: Record<string, string> = {};

    for (const [name, value] of entries) {
      if (typeof value === "string") {
        resolved[name] = value;
        continue;
      }

      const secret = yield* getSecret(value.secretId).pipe(
        Effect.mapError((error) => onError?.(error, name, value) ?? error),
      );
      if (secret === null) {
        if (missing === "drop") continue;
        return yield* Effect.fail(onMissing(name, value));
      }

      resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
    }

    return Object.keys(resolved).length > 0 ? resolved : undefined;
  });
};

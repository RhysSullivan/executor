import type {
  LocalConfigSecretInput,
  LocalConfigSource,
  LocalExecutorConfig,
  SecretRef,
  Source,
} from "#schema";
import {
  LocalConfigSecretInputSchema,
} from "#schema";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  toConfigSecretProviderId,
} from "../../scope/config-secrets";
import {
  cloneJson,
  configSourceBaseFromLocalSource,
  trimOrNull,
} from "./config";

export const createPluginLocalConfigEntrySchema = <
  TKind extends string,
  TConfig,
>(
  input: {
    kind: TKind;
    config: Schema.Schema<TConfig, any, never>;
  },
) =>
  Schema.Struct({
    kind: Schema.Literal(input.kind),
    name: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    enabled: Schema.optional(Schema.Boolean),
    config: input.config,
    connection: Schema.optional(Schema.Unknown),
    binding: Schema.optional(Schema.Unknown),
  });

export const pluginLocalConfigSourceFromConfig = <TConfig>(input: {
  source: Source;
  config: TConfig;
}): LocalConfigSource => ({
  ...configSourceBaseFromLocalSource({
    source: input.source,
  }),
  kind: input.source.kind as LocalConfigSource["kind"],
  config: cloneJson(input.config),
});

const decodeLocalConfigSecretInputOption = Schema.decodeUnknownOption(
  LocalConfigSecretInputSchema,
);

const resolveDefaultConfigSecretProviderAlias = (
  config: LocalExecutorConfig | null | undefined,
): string | null => {
  const defaultAlias = trimOrNull(config?.secrets?.defaults?.env);
  if (defaultAlias !== null && config?.secrets?.providers?.[defaultAlias]) {
    return defaultAlias;
  }

  return config?.secrets?.providers?.default ? "default" : null;
};

export const secretRefFromLocalConfigSecretInput = (input: {
  auth: LocalConfigSecretInput;
  loadedConfig: LocalExecutorConfig | null;
}): SecretRef => {
  if (typeof input.auth === "string") {
    const providerAlias = resolveDefaultConfigSecretProviderAlias(
      input.loadedConfig,
    );

    return {
      providerId: providerAlias ? toConfigSecretProviderId(providerAlias) : "env",
      handle: input.auth,
    };
  }

  return {
    providerId:
      input.auth.provider === "params"
        ? "params"
        : input.auth.provider
          ? toConfigSecretProviderId(input.auth.provider)
          : input.auth.source === "params"
            ? "params"
            : "env",
    handle: input.auth.id,
  };
};

export const decodeCurrentOrLegacyLocalConfigAuth = <TAuth>(input: {
  auth: unknown;
  authSchema: Schema.Schema<TAuth, any, never>;
  loadedConfig: LocalExecutorConfig | null;
  onLegacySecretRef: (ref: SecretRef) => TAuth;
  fallback: TAuth;
}): TAuth => {
  if (input.auth === undefined) {
    return input.fallback;
  }

  const current = Schema.decodeUnknownOption(input.authSchema)(input.auth);
  if (Option.isSome(current)) {
    return current.value;
  }

  const legacy = decodeLocalConfigSecretInputOption(input.auth);
  if (Option.isSome(legacy)) {
    return input.onLegacySecretRef(
      secretRefFromLocalConfigSecretInput({
        auth: legacy.value,
        loadedConfig: input.loadedConfig,
      }),
    );
  }

  throw new Error("Unsupported local source auth configuration.");
};

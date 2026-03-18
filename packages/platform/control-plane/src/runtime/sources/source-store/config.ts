import type {
  LocalConfigSecretInput,
  LocalConfigSource,
  Source,
  SourceId,
} from "#schema";
import { SourceIdSchema } from "#schema";

import type { LoadedLocalExecutorConfig } from "../../local/config";
import { LocalUnsupportedSourceKindError } from "../../local/errors";
import {
  fromConfigSecretProviderId,
  toConfigSecretProviderId,
} from "../../local/config-secrets";
import { getSourceAdapterForSource } from "../source-adapters";
import { slugify } from "../slug";

export const trimOrNull = (value: string | null | undefined): string | null => {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const cloneJson = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

export const deriveLocalSourceId = (
  source: Pick<Source, "namespace" | "name">,
  used: ReadonlySet<string>,
): SourceId => {
  const base = trimOrNull(source.namespace) ?? trimOrNull(source.name) ?? "source";
  const slugBase = slugify(base) || "source";
  let candidate = slugBase;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${slugBase}-${counter}`;
    counter += 1;
  }
  return SourceIdSchema.make(candidate);
};

const resolveLocalConfigSecretProviderAlias = (
  config: LoadedLocalExecutorConfig["config"],
): string | null => {
  const defaultAlias = trimOrNull(config?.secrets?.defaults?.env);
  if (defaultAlias !== null && config?.secrets?.providers?.[defaultAlias]) {
    return defaultAlias;
  }

  return config?.secrets?.providers?.default ? "default" : null;
};

export const sourceAuthFromConfigInput = (input: {
  auth: unknown;
  config: LoadedLocalExecutorConfig["config"];
  existing: Source["auth"] | null;
}): Source["auth"] => {
  if (input.auth === undefined) {
    return input.existing ?? { kind: "none" };
  }

  if (typeof input.auth === "string") {
    const providerAlias = resolveLocalConfigSecretProviderAlias(input.config);
    return {
      kind: "bearer",
      headerName: "Authorization",
      prefix: "Bearer ",
      token: {
        providerId: providerAlias ? toConfigSecretProviderId(providerAlias) : "env",
        handle: input.auth,
      },
    };
  }

  if (typeof input.auth === "object" && input.auth !== null) {
    const explicit = input.auth as {
      source?: string;
      provider?: string;
      id?: string;
    };
    const providerAlias = trimOrNull(explicit.provider);
    const providerId = providerAlias
      ? providerAlias === "params"
        ? "params"
        : toConfigSecretProviderId(providerAlias)
      : explicit.source === "env"
        ? "env"
        : explicit.source === "params"
          ? "params"
          : null;
    const handle = trimOrNull(explicit.id);
    if (providerId && handle) {
      return {
        kind: "bearer",
        headerName: "Authorization",
        prefix: "Bearer ",
        token: {
          providerId,
          handle,
        },
      };
    }
  }

  return input.existing ?? { kind: "none" };
};

const configAuthFromSource = (input: {
  source: Source;
  existingConfigAuth: LocalConfigSecretInput | undefined;
  config: LoadedLocalExecutorConfig["config"];
}): LocalConfigSecretInput | undefined => {
  if (input.source.auth.kind !== "bearer") {
    return input.existingConfigAuth;
  }

  if (input.source.auth.token.providerId === "env") {
    return input.source.auth.token.handle;
  }

  if (input.source.auth.token.providerId === "params") {
    return {
      source: "params",
      provider: "params",
      id: input.source.auth.token.handle,
    };
  }

  const provider = fromConfigSecretProviderId(input.source.auth.token.providerId);
  if (provider !== null) {
    const configuredProvider = input.config?.secrets?.providers?.[provider];
    if (configuredProvider) {
      return {
        source: configuredProvider.source,
        provider,
        id: input.source.auth.token.handle,
      };
    }
  }

  return input.existingConfigAuth;
};

export const configSourceFromLocalSource = (input: {
  source: Source;
  existingConfigAuth: LocalConfigSecretInput | undefined;
  config: LoadedLocalExecutorConfig["config"];
}): LocalConfigSource => {
  const auth = configAuthFromSource({
    source: input.source,
    existingConfigAuth: input.existingConfigAuth,
    config: input.config,
  });

  const common = {
    ...(trimOrNull(input.source.name) !== trimOrNull(input.source.id)
      ? { name: input.source.name }
      : {}),
    ...(trimOrNull(input.source.namespace) !== trimOrNull(input.source.id)
      ? { namespace: input.source.namespace ?? undefined }
      : {}),
    ...(input.source.enabled === false ? { enabled: false } : {}),
    connection: {
      endpoint: input.source.endpoint,
      ...(auth !== undefined ? { auth } : {}),
    },
  };

  const adapter = getSourceAdapterForSource(input.source);
  if (adapter.localConfigBindingSchema === null) {
    throw new LocalUnsupportedSourceKindError({
      message: `Unsupported source kind for local config: ${input.source.kind}`,
      kind: input.source.kind,
    });
  }

  return {
    kind: input.source.kind as LocalConfigSource["kind"],
    ...common,
    binding: cloneJson(adapter.localConfigBindingFromSource(input.source)),
  } as LocalConfigSource;
};

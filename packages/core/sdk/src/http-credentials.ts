import { Effect } from "effect";

import type { StorageFailure } from "@executor-js/storage-core";

import {
  ConfiguredCredentialBinding,
  type ConfiguredCredentialValue,
  type CredentialBindingRef,
  type CredentialBindingsFacade,
  type CredentialBindingValue,
} from "./credential-bindings";
import { ScopeId, SecretId } from "./ids";

export type HttpCredentialInput = ConfiguredCredentialValue | DirectHttpSecretCredentialInput;

export interface DirectHttpSecretCredentialInput {
  readonly secretId: string;
  readonly prefix?: string;
  readonly targetScope?: string;
  readonly secretScopeId?: string;
}

export interface PreparedHttpCredentialBinding {
  readonly slotKey: string;
  readonly value: CredentialBindingValue;
  readonly targetScope?: ScopeId;
}

export interface PreparedHttpCredentialMap {
  readonly values: Record<string, ConfiguredCredentialValue>;
  readonly bindings: readonly PreparedHttpCredentialBinding[];
}

const scopeId = (scope: ScopeId | string): ScopeId => ScopeId.make(String(scope));

const isConfiguredBinding = (value: HttpCredentialInput): value is ConfiguredCredentialBinding =>
  typeof value === "object" && value !== null && "kind" in value && value.kind === "binding";

const isDirectHttpSecretCredentialInput = (
  value: HttpCredentialInput,
): value is DirectHttpSecretCredentialInput =>
  typeof value === "object" && value !== null && "secretId" in value;

export const prepareHttpCredentialMap = <TInput extends HttpCredentialInput>(options: {
  readonly values: Record<string, TInput> | undefined;
  readonly slotForName: (name: string) => string;
}): PreparedHttpCredentialMap => {
  const values: Record<string, ConfiguredCredentialValue> = {};
  const bindings: PreparedHttpCredentialBinding[] = [];

  for (const [name, value] of Object.entries(options.values ?? {})) {
    if (typeof value === "string") {
      values[name] = value;
      continue;
    }

    if (isConfiguredBinding(value)) {
      values[name] = value;
      continue;
    }

    if (!isDirectHttpSecretCredentialInput(value)) continue;

    const slotKey = options.slotForName(name);
    values[name] = ConfiguredCredentialBinding.make({
      kind: "binding",
      slot: slotKey,
      prefix: value.prefix,
    });
    bindings.push({
      slotKey,
      targetScope:
        "targetScope" in value && value.targetScope ? scopeId(value.targetScope) : undefined,
      value: {
        kind: "secret",
        secretId: SecretId.make(value.secretId),
        ...("secretScopeId" in value && value.secretScopeId
          ? { secretScopeId: scopeId(value.secretScopeId) }
          : {}),
      },
    });
  }

  return { values, bindings };
};

export const resolveSourceCredentialBinding = (options: {
  readonly credentialBindings: Pick<CredentialBindingsFacade, "listForSource">;
  readonly pluginId: string;
  readonly sourceId: string;
  readonly sourceScope: ScopeId | string;
  readonly slotKey: string;
}): Effect.Effect<CredentialBindingRef | null, StorageFailure> =>
  Effect.gen(function* () {
    const bindings = yield* options.credentialBindings.listForSource({
      pluginId: options.pluginId,
      sourceId: options.sourceId,
      sourceScope: scopeId(options.sourceScope),
    });
    return bindings.find((binding) => binding.slotKey === options.slotKey) ?? null;
  });

export type SecretCredentialBindingRef = Omit<CredentialBindingRef, "value"> & {
  readonly value: Extract<CredentialBindingValue, { readonly kind: "secret" }>;
};

export const resolveConfiguredHttpCredentialMap = <SecretError, PluginError>(options: {
  readonly credentialBindings: Pick<CredentialBindingsFacade, "listForSource">;
  readonly pluginId: string;
  readonly sourceId: string;
  readonly sourceScope: ScopeId | string;
  readonly values: Record<string, ConfiguredCredentialValue> | undefined;
  readonly empty?: "undefined" | "record";
  readonly getSecretAtScope: (
    secretId: SecretId,
    scopeId: ScopeId,
    context: {
      readonly name: string;
      readonly binding: SecretCredentialBindingRef;
    },
  ) => Effect.Effect<string | null, SecretError>;
  readonly onMissingBinding: (name: string, value: ConfiguredCredentialBinding) => PluginError;
  readonly onMissingSecret: (name: string, binding: SecretCredentialBindingRef) => PluginError;
}): Effect.Effect<Record<string, string> | undefined, SecretError | PluginError | StorageFailure> =>
  Effect.gen(function* () {
    const entries = Object.entries(options.values ?? {});
    if (entries.length === 0) {
      return options.empty === "record" ? {} : undefined;
    }

    const resolved: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (typeof value === "string") {
        resolved[name] = value;
        continue;
      }

      const binding = yield* resolveSourceCredentialBinding({
        credentialBindings: options.credentialBindings,
        pluginId: options.pluginId,
        sourceId: options.sourceId,
        sourceScope: options.sourceScope,
        slotKey: value.slot,
      });
      if (binding?.value.kind === "secret") {
        const secretBinding = binding as SecretCredentialBindingRef;
        const secret = yield* options.getSecretAtScope(
          secretBinding.value.secretId,
          secretBinding.value.secretScopeId ?? secretBinding.scopeId,
          { name, binding: secretBinding },
        );
        if (secret === null) {
          return yield* Effect.fail(options.onMissingSecret(name, secretBinding));
        }
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
        continue;
      }

      if (binding?.value.kind === "text") {
        resolved[name] = value.prefix ? `${value.prefix}${binding.value.text}` : binding.value.text;
        continue;
      }

      return yield* Effect.fail(options.onMissingBinding(name, value));
    }

    return Object.keys(resolved).length > 0 || options.empty === "record" ? resolved : undefined;
  });

export const targetScopeForPreparedHttpCredentialBinding = <E>(
  fallbackTargetScope: ScopeId | string | undefined,
  binding: PreparedHttpCredentialBinding,
  onMissing: (binding: PreparedHttpCredentialBinding) => E,
): Effect.Effect<ScopeId, E> => {
  const targetScope = binding.targetScope ?? fallbackTargetScope;
  return targetScope ? Effect.succeed(scopeId(targetScope)) : Effect.fail(onMissing(binding));
};

export const setPreparedHttpCredentialBindings = <E>(options: {
  readonly credentialBindings: Pick<CredentialBindingsFacade, "set">;
  readonly pluginId: string;
  readonly sourceId: string;
  readonly sourceScope: ScopeId | string;
  readonly fallbackTargetScope?: ScopeId | string;
  readonly bindings: readonly PreparedHttpCredentialBinding[];
  readonly onMissingTargetScope: (binding: PreparedHttpCredentialBinding) => E;
}): Effect.Effect<void, E | StorageFailure> =>
  Effect.forEach(
    options.bindings,
    (binding) =>
      Effect.gen(function* () {
        const targetScope = yield* targetScopeForPreparedHttpCredentialBinding(
          options.fallbackTargetScope,
          binding,
          options.onMissingTargetScope,
        );
        yield* options.credentialBindings.set({
          targetScope,
          pluginId: options.pluginId,
          sourceId: options.sourceId,
          sourceScope: scopeId(options.sourceScope),
          slotKey: binding.slotKey,
          value: binding.value,
        });
      }),
    { discard: true },
  );

export const replacePreparedHttpCredentialBindingsForSource = (options: {
  readonly credentialBindings: Pick<CredentialBindingsFacade, "replaceForSource">;
  readonly pluginId: string;
  readonly sourceId: string;
  readonly sourceScope: ScopeId | string;
  readonly targetScope: ScopeId | string;
  readonly slotPrefixes: readonly string[];
  readonly bindings: readonly PreparedHttpCredentialBinding[];
}): Effect.Effect<readonly CredentialBindingRef[], StorageFailure> =>
  options.credentialBindings.replaceForSource({
    targetScope: scopeId(options.targetScope),
    pluginId: options.pluginId,
    sourceId: options.sourceId,
    sourceScope: scopeId(options.sourceScope),
    slotPrefixes: [...options.slotPrefixes],
    bindings: options.bindings.map((binding) => ({
      slotKey: binding.slotKey,
      value: binding.value,
    })),
  });

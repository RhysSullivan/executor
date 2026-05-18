import { Data, Effect } from "effect";
import {
  ConnectionId,
  ConfiguredCredentialBinding,
  type ConfiguredCredentialValue,
  type CredentialBindingValue,
  type ReplaceCredentialBindingValue,
  type ScopedSecretCredentialInput,
  SecretId,
  ScopeId,
} from "@executor-js/sdk/shared";

import type {
  HttpCredentialInput,
  HttpRequestConfigureInput,
  HttpRequestSourceConfig,
} from "./types";

export class UnknownHttpCredentialFieldError extends Data.TaggedError(
  "UnknownHttpCredentialFieldError",
)<{
  readonly section: string;
  readonly placement: "headers" | "query";
  readonly fieldName: string;
  readonly declared: readonly string[];
}> {}

export type HttpNamedCredentialInput =
  | ConfiguredCredentialValue
  | ScopedSecretCredentialInput
  | {
      readonly secretId: string;
      readonly prefix?: string;
      readonly targetScope?: string;
      readonly secretScopeId?: string;
    };

export interface CompiledHttpNamedCredentialBinding {
  readonly slot: string;
  readonly value: CredentialBindingValue;
  readonly targetScope?: string;
}

export const compileHttpNamedCredentialMap = (
  values: Record<string, HttpNamedCredentialInput | HttpCredentialInput> | undefined,
  slotForName: (name: string) => string,
): {
  readonly values: Record<string, ConfiguredCredentialValue>;
  readonly bindings: readonly CompiledHttpNamedCredentialBinding[];
} => {
  const nextValues: Record<string, ConfiguredCredentialValue> = {};
  const bindings: CompiledHttpNamedCredentialBinding[] = [];
  for (const [name, value] of Object.entries(values ?? {})) {
    if (typeof value === "string") {
      nextValues[name] = value;
      continue;
    }
    if ("kind" in value) {
      if (value.kind === "binding") {
        nextValues[name] = value;
        continue;
      }
      const slot = slotForName(name);
      nextValues[name] = ConfiguredCredentialBinding.make({
        kind: "binding",
        slot,
        prefix: "prefix" in value ? value.prefix : undefined,
      });
      bindings.push({
        slot,
        value: httpCredentialInputToBindingValue(value),
      });
      continue;
    }
    const slot = slotForName(name);
    nextValues[name] = ConfiguredCredentialBinding.make({
      kind: "binding",
      slot,
      prefix: value.prefix,
    });
    bindings.push({
      slot,
      targetScope: "targetScope" in value ? value.targetScope : undefined,
      value: {
        kind: "secret",
        secretId: SecretId.make(value.secretId),
        ...("secretScopeId" in value && value.secretScopeId
          ? { secretScopeId: ScopeId.make(value.secretScopeId) }
          : {}),
      },
    });
  }
  return { values: nextValues, bindings };
};

export const httpCredentialInputToBindingValue = (
  input: HttpCredentialInput,
): CredentialBindingValue => {
  if (typeof input === "string") {
    return {
      kind: "text",
      text: input,
    };
  }
  if (input.kind === "text") {
    return {
      kind: "text",
      text: input.text,
    };
  }
  if (input.kind === "secret") {
    return {
      kind: "secret",
      secretId: SecretId.make(input.secretId),
      ...(input.secretScope ? { secretScopeId: ScopeId.make(input.secretScope) } : {}),
    };
  }
  if (input.kind === "connection") {
    return {
      kind: "connection",
      connectionId: ConnectionId.make(input.connectionId),
    };
  }
  return input;
};

export const compileHttpRequestConfigureBindings = (input: {
  readonly section: string;
  readonly sourceConfig: HttpRequestSourceConfig | undefined;
  readonly configure: HttpRequestConfigureInput | undefined;
}): Effect.Effect<readonly ReplaceCredentialBindingValue[], UnknownHttpCredentialFieldError> =>
  Effect.gen(function* () {
    const configure = input.configure;
    if (!configure) return [];

    const bindings: ReplaceCredentialBindingValue[] = [];

    for (const [placement, configuredValues] of [
      ["headers", configure.headers],
      ["query", configure.query],
    ] as const) {
      const declared = input.sourceConfig?.[placement] ?? {};
      for (const [name, value] of Object.entries(configuredValues ?? {})) {
        const slot = declared[name];
        if (!slot) {
          return yield* new UnknownHttpCredentialFieldError({
            section: input.section,
            placement,
            fieldName: name,
            declared: Object.keys(declared),
          });
        }
        bindings.push({
          slotKey: slot.slotKey,
          value: httpCredentialInputToBindingValue(value),
        });
      }
    }

    const oauth = configure.oauth;
    if (oauth && input.sourceConfig?.oauth) {
      if (oauth.clientId) {
        bindings.push({
          slotKey: input.sourceConfig.oauth.clientIdSlot,
          value: httpCredentialInputToBindingValue(oauth.clientId),
        });
      }
      if (oauth.clientSecret) {
        bindings.push({
          slotKey: input.sourceConfig.oauth.clientSecretSlot ?? "",
          value: httpCredentialInputToBindingValue(oauth.clientSecret),
        });
      }
      if (oauth.connection) {
        bindings.push({
          slotKey: input.sourceConfig.oauth.connectionSlot,
          value: httpCredentialInputToBindingValue(oauth.connection),
        });
      }
    }

    return bindings.filter((binding) => binding.slotKey.length > 0);
  });

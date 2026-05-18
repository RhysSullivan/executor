import { Effect } from "effect";
import type { CredentialBindingRef } from "@executor-js/sdk/shared";

import type { HttpRequestSourceConfig } from "./types";

export interface ResolvedHttpRequestCredentials {
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
}

export const resolveHttpRequestCredentials = <E>(input: {
  readonly config: HttpRequestSourceConfig | undefined;
  readonly resolveBinding: (slotKey: string) => Effect.Effect<CredentialBindingRef | null, E>;
  readonly getSecret: (id: string, scope: string | undefined) => Effect.Effect<string | null, E>;
  readonly getConnectionAccessToken?: (id: string) => Effect.Effect<string, E>;
}): Effect.Effect<ResolvedHttpRequestCredentials, E> =>
  Effect.gen(function* () {
    const headers: Record<string, string> = {};
    const query: Record<string, string> = {};

    for (const [target, config] of [
      [headers, input.config?.headers],
      [query, input.config?.query],
    ] as const) {
      for (const [name, slot] of Object.entries(config ?? {})) {
        const binding = yield* input.resolveBinding(slot.slotKey);
        if (!binding) continue;
        const value = yield* resolveBindingValue(binding, input);
        if (value == null) continue;
        target[name] = slot.prefix ? `${slot.prefix}${value}` : value;
      }
    }

    return {
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(query).length > 0 ? { query } : {}),
    };
  });

const resolveBindingValue = <E>(
  binding: CredentialBindingRef,
  input: {
    readonly getSecret: (id: string, scope: string | undefined) => Effect.Effect<string | null, E>;
    readonly getConnectionAccessToken?: (id: string) => Effect.Effect<string, E>;
  },
): Effect.Effect<string | null, E> => {
  if (binding.value.kind === "text") return Effect.succeed(binding.value.text);
  if (binding.value.kind === "secret") {
    return input.getSecret(binding.value.secretId, binding.value.secretScopeId);
  }
  if (input.getConnectionAccessToken) {
    return input.getConnectionAccessToken(binding.value.connectionId);
  }
  return Effect.succeed(null);
};

export const applyHttpRequestCredentials = (
  url: URL,
  init: RequestInit,
  credentials: ResolvedHttpRequestCredentials,
): RequestInit => {
  for (const [name, value] of Object.entries(credentials.query ?? {})) {
    url.searchParams.set(name, value);
  }
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(credentials.headers ?? {})) {
    headers.set(name, value);
  }
  return {
    ...init,
    headers,
  };
};

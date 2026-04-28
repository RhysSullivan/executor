import type { ScopeId } from "@executor/sdk";

import { oauth2ClientSecretSlot } from "./store";
import type { ConfiguredHeaderValue, OpenApiSourceBindingValue } from "./types";

export type BindingRowForCredentialStatus = {
  readonly slot: string;
  readonly scopeId: ScopeId;
  readonly value: OpenApiSourceBindingValue;
};

export type SourceForCredentialStatus = {
  readonly config: {
    readonly headers?: Record<string, ConfiguredHeaderValue>;
    readonly oauth2?: {
      readonly securitySchemeName: string;
      readonly flow: "authorizationCode" | "clientCredentials";
      readonly clientIdSlot: string;
      readonly clientSecretSlot: string | null;
      readonly connectionSlot: string;
    };
  };
};

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: ScopeId): number =>
  ranks.get(scopeId as string) ?? Number.MAX_SAFE_INTEGER;

export const effectiveBindingForScope = (
  rows: readonly BindingRowForCredentialStatus[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
): BindingRowForCredentialStatus | null =>
  rows
    .filter(
      (row) =>
        row.slot === slot &&
        scopeRank(ranks, row.scopeId) >= scopeRank(ranks, targetScope),
    )
    .sort(
      (a, b) =>
        scopeRank(ranks, a.scopeId) -
        scopeRank(ranks, b.scopeId),
    )[0] ?? null;

const hasSecretBinding = (
  rows: readonly BindingRowForCredentialStatus[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
) => effectiveBindingForScope(rows, slot, targetScope, ranks)?.value.kind === "secret";

const hasConnectionBinding = (
  rows: readonly BindingRowForCredentialStatus[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
) => effectiveBindingForScope(rows, slot, targetScope, ranks)?.value.kind === "connection";

const effectiveClientSecretSlot = (oauth2: {
  readonly securitySchemeName: string;
  readonly clientSecretSlot: string | null;
}): string => oauth2.clientSecretSlot ?? oauth2ClientSecretSlot(oauth2.securitySchemeName);

export function missingCredentialLabels(
  source: SourceForCredentialStatus,
  bindings: readonly BindingRowForCredentialStatus[],
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
): string[] {
  const missing: string[] = [];

  for (const [headerName, value] of Object.entries(source.config.headers ?? {})) {
    if (typeof value === "string") continue;
    if (!hasSecretBinding(bindings, value.slot, targetScope, ranks)) {
      missing.push(headerName);
    }
  }

  const oauth2 = source.config.oauth2;
  if (!oauth2) return missing;

  if (!hasSecretBinding(bindings, oauth2.clientIdSlot, targetScope, ranks)) {
    missing.push("Client ID");
  }

  const clientSecretSlot = effectiveClientSecretSlot(oauth2);
  if (!hasSecretBinding(bindings, clientSecretSlot, targetScope, ranks)) {
    missing.push("Client Secret");
  }

  if (!hasConnectionBinding(bindings, oauth2.connectionSlot, targetScope, ranks)) {
    missing.push(
      oauth2.flow === "clientCredentials" ? "OAuth client connection" : "OAuth sign-in",
    );
  }

  return missing;
}

import { type UpsertCredentialBindingPayload } from "@executor-v2/management-api";
import {
  type AuthConnection,
  type AuthConnectionStrategy,
  type SourceAuthBinding,
  type SourceCredentialBinding,
} from "@executor-v2/schema";

export const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const sourceIdFromSourceKey = (sourceKey: string): string | null => {
  const trimmed = sourceKey.trim();
  if (!trimmed.startsWith("source:")) {
    return null;
  }

  const sourceId = trimmed.slice("source:".length).trim();
  return sourceId.length > 0 ? sourceId : null;
};

export const sourceKeyFromSourceId = (sourceId: string): string => `source:${sourceId}`;

export const strategyFromProvider = (
  provider: SourceCredentialBinding["provider"],
): AuthConnectionStrategy => {
  if (provider === "api_key") return "api_key";
  if (provider === "bearer") return "bearer";
  if (provider === "oauth2") return "oauth2";
  if (provider === "basic") return "basic";
  return "custom";
};

const providerFromStrategy = (
  strategy: AuthConnectionStrategy,
): SourceCredentialBinding["provider"] => {
  if (strategy === "api_key") return "api_key";
  if (strategy === "bearer") return "bearer";
  if (strategy === "oauth2") return "oauth2";
  if (strategy === "basic") return "basic";
  return "custom";
};

export const toCompatSourceCredentialBinding = (
  binding: SourceAuthBinding,
  connection: AuthConnection,
  hasSecret: boolean,
): SourceCredentialBinding => ({
  id: binding.id as unknown as SourceCredentialBinding["id"],
  credentialId: connection.id as unknown as SourceCredentialBinding["credentialId"],
  organizationId: binding.organizationId,
  workspaceId: binding.workspaceId,
  accountId: binding.accountId,
  scopeType: binding.scopeType,
  sourceKey: sourceKeyFromSourceId(binding.sourceId),
  provider: providerFromStrategy(connection.strategy),
  hasSecret,
  additionalHeadersJson: connection.additionalHeadersJson,
  boundAuthFingerprint: null,
  createdAt: binding.createdAt,
  updatedAt: Math.max(binding.updatedAt, connection.updatedAt),
});

export const sortCredentialBindings = (
  bindings: ReadonlyArray<SourceCredentialBinding>,
): Array<SourceCredentialBinding> =>
  [...bindings].sort((left, right) => {
    const leftKey = `${left.sourceKey}:${left.provider}:${left.id}`.toLowerCase();
    const rightKey = `${right.sourceKey}:${right.provider}:${right.id}`.toLowerCase();
    return leftKey.localeCompare(rightKey);
  });

const parseJsonObject = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

export type OAuthRefreshConfig = {
  tokenEndpoint?: string;
  authorizationServer?: string;
  clientId?: string;
  clientSecretHandle?: string;
  sourceUrl?: string;
  clientInformationJson?: string;
};

export const parseOAuthRefreshConfig = (value: string | null): OAuthRefreshConfig => {
  if (!value) {
    return {};
  }

  const parsed = parseJsonObject(value);
  return {
    ...(normalizeString(parsed.tokenEndpoint)
      ? { tokenEndpoint: normalizeString(parsed.tokenEndpoint)! }
      : {}),
    ...(normalizeString(parsed.authorizationServer)
      ? { authorizationServer: normalizeString(parsed.authorizationServer)! }
      : {}),
    ...(normalizeString(parsed.clientId)
      ? { clientId: normalizeString(parsed.clientId)! }
      : {}),
    ...(normalizeString(parsed.clientSecretHandle)
      ? { clientSecretHandle: normalizeString(parsed.clientSecretHandle)! }
      : {}),
    ...(normalizeString(parsed.sourceUrl)
      ? { sourceUrl: normalizeString(parsed.sourceUrl)! }
      : {}),
    ...(normalizeString(parsed.clientInformationJson)
      ? { clientInformationJson: normalizeString(parsed.clientInformationJson)! }
      : {}),
  };
};

export const encodeOAuthRefreshConfig = (config: OAuthRefreshConfig): string | null => {
  const payload: Record<string, string> = {};

  if (config.tokenEndpoint) payload.tokenEndpoint = config.tokenEndpoint;
  if (config.authorizationServer) payload.authorizationServer = config.authorizationServer;
  if (config.clientId) payload.clientId = config.clientId;
  if (config.clientSecretHandle) payload.clientSecretHandle = config.clientSecretHandle;
  if (config.sourceUrl) payload.sourceUrl = config.sourceUrl;
  if (config.clientInformationJson) payload.clientInformationJson = config.clientInformationJson;

  if (Object.keys(payload).length === 0) {
    return null;
  }

  return JSON.stringify(payload);
};

export const buildOAuthRefreshConfigFromPayload = (
  payload: UpsertCredentialBindingPayload,
  existing: OAuthRefreshConfig,
): OAuthRefreshConfig => ({
  tokenEndpoint:
    normalizeString(payload.oauthTokenEndpoint)
    ?? existing.tokenEndpoint,
  authorizationServer:
    normalizeString(payload.oauthAuthorizationServer)
    ?? existing.authorizationServer,
  clientId: normalizeString(payload.oauthClientId) ?? existing.clientId,
  clientSecretHandle: existing.clientSecretHandle,
  sourceUrl: normalizeString(payload.oauthSourceUrl) ?? existing.sourceUrl,
  clientInformationJson:
    normalizeString(payload.oauthClientInformationJson)
    ?? existing.clientInformationJson,
});

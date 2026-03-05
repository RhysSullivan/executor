import type { UpsertSourcePayload } from "@executor-v2/management-api";
import type {
  Source,
  SourceId,
  SourceKind,
  SourceStatus,
  WorkspaceId,
} from "@executor-v2/schema";

export type LegacySourceType = "openapi" | "mcp" | "graphql";
export type LegacyAuthType = "none" | "bearer" | "apiKey" | "basic";
export type LegacyAuthMode = "workspace" | "organization" | "account";

export type LegacyToolSourceRecord = {
  id: SourceId;
  workspaceId: WorkspaceId;
  name: string;
  type: LegacySourceType;
  endpoint: string;
  enabled: boolean;
  status: SourceStatus;
  config: Record<string, unknown>;
  sourceHash: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type LegacySourceFormState = {
  id?: SourceId;
  name: string;
  type: LegacySourceType;
  endpoint: string;
  baseUrl: string;
  mcpTransport: "auto" | "streamable-http" | "sse";
  authType: LegacyAuthType;
  authMode: LegacyAuthMode;
  apiKeyHeader: string;
  enabled: boolean;
};

const supportedKinds: ReadonlyArray<LegacySourceType> = [
  "openapi",
  "mcp",
  "graphql",
];

const normalizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const normalizeConfig = (configJson: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(configJson);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const normalizeSourceType = (kind: SourceKind): LegacySourceType => {
  if (supportedKinds.includes(kind as LegacySourceType)) {
    return kind as LegacySourceType;
  }

  return "openapi";
};

const endpointFromConfig = (
  type: LegacySourceType,
  config: Record<string, unknown>,
  fallback: string,
): string => {
  if (type === "mcp") {
    return normalizeString(config.url) || fallback;
  }

  if (type === "graphql") {
    return normalizeString(config.endpoint) || fallback;
  }

  const specUrl = normalizeString(config.specUrl);
  if (specUrl.length > 0) {
    return specUrl;
  }

  const spec = config.spec;
  if (typeof spec === "string") {
    const normalizedSpec = spec.trim();
    if (normalizedSpec.length > 0) {
      return normalizedSpec;
    }
  }

  return fallback;
};

const authFromConfig = (config: Record<string, unknown>): {
  authType: LegacyAuthType;
  authMode: LegacyAuthMode;
  apiKeyHeader: string;
} => {
  const authValue = config.auth;
  if (!authValue || typeof authValue !== "object") {
    return {
      authType: "none",
      authMode: "workspace",
      apiKeyHeader: "Authorization",
    };
  }

  const auth = authValue as Record<string, unknown>;
  const rawType = normalizeString(auth.type);
  const rawMode = normalizeString(auth.mode);
  const rawHeader = normalizeString(auth.header);

  const authType: LegacyAuthType =
    rawType === "bearer" || rawType === "apiKey" || rawType === "basic"
      ? rawType
      : "none";

  const authMode: LegacyAuthMode =
    rawMode === "organization" || rawMode === "account"
      ? rawMode
      : "workspace";

  return {
    authType,
    authMode,
    apiKeyHeader: rawHeader || "Authorization",
  };
};

export const sourceToLegacyRecord = (source: Source): LegacyToolSourceRecord => {
  const type = normalizeSourceType(source.kind);
  const config = normalizeConfig(source.configJson);
  const endpoint = endpointFromConfig(type, config, source.endpoint);

  return {
    id: source.id,
    workspaceId: source.workspaceId,
    name: source.name,
    type,
    endpoint,
    enabled: source.enabled,
    status: source.status,
    config,
    sourceHash: source.sourceHash,
    lastError: source.lastError,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
};

export const buildSourceConfig = (input: {
  type: LegacySourceType;
  endpoint: string;
  baseUrl: string;
  mcpTransport: "auto" | "streamable-http" | "sse";
  authType: LegacyAuthType;
  authMode: LegacyAuthMode;
  apiKeyHeader: string;
}): Record<string, unknown> => {
  const endpoint = input.endpoint.trim();

  if (input.type === "mcp") {
    return {
      url: endpoint,
      ...(input.mcpTransport !== "auto" ? { transport: input.mcpTransport } : {}),
    };
  }

  if (input.type === "graphql") {
    return {
      endpoint,
    };
  }

  return {
    spec: endpoint,
    specUrl: endpoint,
    ...(input.baseUrl.trim().length > 0 ? { baseUrl: input.baseUrl.trim() } : {}),
  };
};

export const formStateFromSource = (
  source: LegacyToolSourceRecord,
): LegacySourceFormState => {
  const config = source.config;
  const auth = authFromConfig(config);

  return {
    id: source.id,
    name: source.name,
    type: source.type,
    endpoint: source.endpoint,
    baseUrl: normalizeString(config.baseUrl),
    mcpTransport:
      normalizeString(config.transport) === "streamable-http"
      || normalizeString(config.transport) === "sse"
        ? (normalizeString(config.transport) as "streamable-http" | "sse")
        : "auto",
    authType: auth.authType,
    authMode: auth.authMode,
    apiKeyHeader: auth.apiKeyHeader,
    enabled: source.enabled,
  };
};

export const upsertPayloadFromForm = (input: {
  workspaceId: WorkspaceId;
  form: LegacySourceFormState;
  sourceId: SourceId;
}): UpsertSourcePayload => {
  const config = buildSourceConfig({
    type: input.form.type,
    endpoint: input.form.endpoint,
    baseUrl: input.form.baseUrl,
    mcpTransport: input.form.mcpTransport,
    authType: input.form.authType,
    authMode: input.form.authMode,
    apiKeyHeader: input.form.apiKeyHeader,
  });

  const endpoint = endpointFromConfig(
    input.form.type,
    config,
    input.form.endpoint.trim(),
  );

  return {
    id: input.sourceId,
    name: input.form.name.trim(),
    kind: input.form.type,
    endpoint,
    enabled: input.form.enabled,
    status: endpoint.length > 0 ? "connected" : "draft",
    configJson: JSON.stringify(config),
    sourceHash: null,
    lastError: null,
  };
};

import type { Source } from "@executor-v2/schema";

export type SourceConfig = Record<string, unknown>;

export type McpTransportPreference = "auto" | "streamable-http" | "sse";

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

const parseJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export const parseSourceConfig = (source: Source): SourceConfig =>
  asRecord(parseJson(source.configJson));

export const resolveSourceEndpoint = (
  source: Source,
  config: SourceConfig,
  candidates: ReadonlyArray<string>,
): string => {
  for (const candidate of candidates) {
    const value = normalizeString(config[candidate]);
    if (value) {
      return value;
    }
  }

  return source.endpoint;
};

export const readStringRecord = (
  value: unknown,
): Record<string, string> => {
  const record = asRecord(value);
  const normalized: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = normalizeString(rawKey);
    const resolvedValue = normalizeString(rawValue);
    if (!key || !resolvedValue) {
      continue;
    }

    normalized[key] = resolvedValue;
  }

  return normalized;
};

export const readQueryParamsFromConfig = (
  config: SourceConfig,
): Record<string, string> => {
  const queryParams = asRecord(config.queryParams);
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(queryParams)) {
    const normalizedKey = normalizeString(key);
    if (!normalizedKey) {
      continue;
    }

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      normalized[normalizedKey] = String(value);
    }
  }

  return normalized;
};

export const readMcpTransportFromConfig = (
  config: SourceConfig,
): McpTransportPreference => {
  const value = normalizeString(config.transport)?.toLowerCase();
  if (value === "streamable-http" || value === "sse") {
    return value;
  }

  return "auto";
};

export const collectSourceHeaders = (
  config: SourceConfig,
): Record<string, string> => {
  return readStringRecord(config.headers);
};

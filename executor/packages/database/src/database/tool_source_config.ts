import { Result } from "better-result";
import type {
  GraphqlToolSourceConfig,
  McpToolSourceConfig,
  OpenApiAuth,
  OpenApiToolSourceConfig,
} from "../../../core/src/tool/source-types";
import type { ToolApprovalMode } from "../../../core/src/types";
import { asRecord } from "../lib/object";

export type ToolSourceType = "mcp" | "openapi" | "graphql";

export type NormalizedMcpToolSourceConfig = Pick<
  McpToolSourceConfig,
  "url" | "auth" | "discoveryHeaders" | "transport" | "queryParams" | "defaultApproval" | "overrides"
>;

export type NormalizedGraphqlToolSourceConfig = Pick<
  GraphqlToolSourceConfig,
  "endpoint" | "schema" | "auth" | "defaultQueryApproval" | "defaultMutationApproval" | "overrides"
>;

export type NormalizedOpenApiToolSourceConfig = Pick<
  OpenApiToolSourceConfig,
  "spec" | "collectionUrl" | "postmanProxyUrl" | "baseUrl" | "auth" | "defaultReadApproval" | "defaultWriteApproval" | "overrides"
>;

export type NormalizedToolSourceConfig =
  | NormalizedMcpToolSourceConfig
  | NormalizedGraphqlToolSourceConfig
  | NormalizedOpenApiToolSourceConfig;

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requiredTrimmedString(
  value: unknown,
  fieldName: string,
): Result<string, Error> {
  const trimmed = optionalTrimmedString(value);
  if (!trimmed) {
    return Result.err(new Error(`Tool source ${fieldName} is required`));
  }
  return Result.ok(trimmed);
}

function normalizeStringMap(
  value: unknown,
  fieldName: string,
): Result<Record<string, string> | undefined, Error> {
  if (value === undefined) return Result.ok(undefined);

  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return Result.ok(undefined);
  }

  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    if (typeof rawValue !== "string") {
      return Result.err(new Error(`Tool source ${fieldName}.${normalizedKey} must be a string`));
    }
    normalized[normalizedKey] = rawValue;
  }

  return Result.ok(Object.keys(normalized).length > 0 ? normalized : undefined);
}

function normalizeApprovalMode(
  value: unknown,
  fieldName: string,
): Result<ToolApprovalMode | undefined, Error> {
  if (value === undefined) return Result.ok(undefined);
  if (value === "auto" || value === "required") {
    return Result.ok(value);
  }
  return Result.err(new Error(`Tool source ${fieldName} must be 'auto' or 'required'`));
}

function normalizeOverrides(
  value: unknown,
  fieldName: string,
): Result<Record<string, { approval?: ToolApprovalMode }> | undefined, Error> {
  if (value === undefined) return Result.ok(undefined);

  const raw = asRecord(value);
  if (Object.keys(raw).length === 0) {
    return Result.ok(undefined);
  }

  const normalized: Record<string, { approval?: ToolApprovalMode }> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = rawKey.trim();
    if (!key) continue;
    const entry = asRecord(rawValue);
    const approvalResult = normalizeApprovalMode(entry.approval, `${fieldName}.${key}.approval`);
    if (approvalResult.isErr()) {
      return approvalResult;
    }
    normalized[key] = approvalResult.value ? { approval: approvalResult.value } : {};
  }

  return Result.ok(Object.keys(normalized).length > 0 ? normalized : undefined);
}

function normalizeAuthMode(
  value: unknown,
): Result<"static" | "workspace" | "actor" | undefined, Error> {
  if (value === undefined) return Result.ok(undefined);
  if (value === "static" || value === "workspace" || value === "actor") {
    return Result.ok(value);
  }
  return Result.err(new Error("Tool source auth.mode must be 'static', 'workspace', or 'actor'"));
}

function normalizeAuth(value: unknown): Result<OpenApiAuth | undefined, Error> {
  if (value === undefined) return Result.ok(undefined);

  const auth = asRecord(value);
  const authType = optionalTrimmedString(auth.type);
  if (!authType) {
    return Result.err(new Error("Tool source auth.type is required when auth is provided"));
  }

  if (authType === "none") {
    return Result.ok({ type: "none" });
  }

  const modeResult = normalizeAuthMode(auth.mode);
  if (modeResult.isErr()) {
    return modeResult;
  }
  const mode = modeResult.value;

  if (authType === "basic") {
    return Result.ok({
      type: "basic",
      mode,
      username: optionalTrimmedString(auth.username),
      password: optionalTrimmedString(auth.password),
    });
  }

  if (authType === "bearer") {
    return Result.ok({
      type: "bearer",
      mode,
      token: optionalTrimmedString(auth.token),
    });
  }

  if (authType === "apiKey") {
    const headerResult = requiredTrimmedString(auth.header, "auth.header");
    if (headerResult.isErr()) {
      return headerResult;
    }
    return Result.ok({
      type: "apiKey",
      mode,
      header: headerResult.value,
      value: optionalTrimmedString(auth.value),
    });
  }

  return Result.err(new Error(`Unsupported tool source auth.type '${authType}'`));
}

function normalizeSpec(
  value: unknown,
): Result<string | Record<string, unknown>, Error> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return Result.err(new Error("Tool source spec is required"));
    }
    return Result.ok(trimmed);
  }

  const specObject = asRecord(value);
  if (Object.keys(specObject).length === 0) {
    return Result.err(new Error("Tool source spec must be a non-empty string or object"));
  }

  return Result.ok(specObject);
}

export function normalizeToolSourceConfig(
  type: "mcp",
  rawConfig: unknown,
): Result<NormalizedMcpToolSourceConfig, Error>;
export function normalizeToolSourceConfig(
  type: "graphql",
  rawConfig: unknown,
): Result<NormalizedGraphqlToolSourceConfig, Error>;
export function normalizeToolSourceConfig(
  type: "openapi",
  rawConfig: unknown,
): Result<NormalizedOpenApiToolSourceConfig, Error>;
export function normalizeToolSourceConfig(
  type: ToolSourceType,
  rawConfig: unknown,
): Result<NormalizedToolSourceConfig, Error>;
export function normalizeToolSourceConfig(
  type: ToolSourceType,
  rawConfig: unknown,
): Result<NormalizedToolSourceConfig, Error> {
  const config = asRecord(rawConfig);

  if (type === "mcp") {
    const urlResult = requiredTrimmedString(config.url, "url");
    if (urlResult.isErr()) {
      return urlResult;
    }

    const transport = config.transport;
    if (transport !== undefined && transport !== "sse" && transport !== "streamable-http") {
      return Result.err(new Error("Tool source transport must be 'sse' or 'streamable-http'"));
    }

    const authResult = normalizeAuth(config.auth);
    if (authResult.isErr()) {
      return authResult;
    }

    const queryParamsResult = normalizeStringMap(config.queryParams, "queryParams");
    if (queryParamsResult.isErr()) {
      return queryParamsResult;
    }

    const discoveryHeadersResult = normalizeStringMap(config.discoveryHeaders, "discoveryHeaders");
    if (discoveryHeadersResult.isErr()) {
      return discoveryHeadersResult;
    }

    const defaultApprovalResult = normalizeApprovalMode(config.defaultApproval, "defaultApproval");
    if (defaultApprovalResult.isErr()) {
      return defaultApprovalResult;
    }

    const overridesResult = normalizeOverrides(config.overrides, "overrides");
    if (overridesResult.isErr()) {
      return overridesResult;
    }

    return Result.ok({
      url: urlResult.value,
      transport,
      auth: authResult.value,
      queryParams: queryParamsResult.value,
      discoveryHeaders: discoveryHeadersResult.value,
      defaultApproval: defaultApprovalResult.value,
      overrides: overridesResult.value,
    });
  }

  if (type === "graphql") {
    const endpointResult = requiredTrimmedString(config.endpoint, "endpoint");
    if (endpointResult.isErr()) {
      return endpointResult;
    }

    const authResult = normalizeAuth(config.auth);
    if (authResult.isErr()) {
      return authResult;
    }

    const defaultQueryApprovalResult = normalizeApprovalMode(
      config.defaultQueryApproval,
      "defaultQueryApproval",
    );
    if (defaultQueryApprovalResult.isErr()) {
      return defaultQueryApprovalResult;
    }

    const defaultMutationApprovalResult = normalizeApprovalMode(
      config.defaultMutationApproval,
      "defaultMutationApproval",
    );
    if (defaultMutationApprovalResult.isErr()) {
      return defaultMutationApprovalResult;
    }

    const overridesResult = normalizeOverrides(config.overrides, "overrides");
    if (overridesResult.isErr()) {
      return overridesResult;
    }

    const schema = asRecord(config.schema);

    return Result.ok({
      endpoint: endpointResult.value,
      schema: Object.keys(schema).length > 0 ? schema : undefined,
      auth: authResult.value,
      defaultQueryApproval: defaultQueryApprovalResult.value,
      defaultMutationApproval: defaultMutationApprovalResult.value,
      overrides: overridesResult.value,
    });
  }

  const specResult = normalizeSpec(config.spec);
  if (specResult.isErr()) {
    return specResult;
  }

  const authResult = normalizeAuth(config.auth);
  if (authResult.isErr()) {
    return authResult;
  }

  const defaultReadApprovalResult = normalizeApprovalMode(
    config.defaultReadApproval,
    "defaultReadApproval",
  );
  if (defaultReadApprovalResult.isErr()) {
    return defaultReadApprovalResult;
  }

  const defaultWriteApprovalResult = normalizeApprovalMode(
    config.defaultWriteApproval,
    "defaultWriteApproval",
  );
  if (defaultWriteApprovalResult.isErr()) {
    return defaultWriteApprovalResult;
  }

  const overridesResult = normalizeOverrides(config.overrides, "overrides");
  if (overridesResult.isErr()) {
    return overridesResult;
  }

  return Result.ok({
    spec: specResult.value,
    collectionUrl: optionalTrimmedString(config.collectionUrl),
    postmanProxyUrl: optionalTrimmedString(config.postmanProxyUrl),
    baseUrl: optionalTrimmedString(config.baseUrl),
    auth: authResult.value,
    defaultReadApproval: defaultReadApprovalResult.value,
    defaultWriteApproval: defaultWriteApprovalResult.value,
    overrides: overridesResult.value,
  });
}

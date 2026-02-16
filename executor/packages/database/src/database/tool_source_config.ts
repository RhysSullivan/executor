import { Result } from "better-result";
import { z } from "zod";
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

const approvalModeSchema = z.enum(["auto", "required"]);
const authModeSchema = z.enum(["static", "workspace", "actor"]);
const mcpTransportSchema = z.enum(["sse", "streamable-http"]);
const overrideEntrySchema = z.object({
  approval: approvalModeSchema.optional(),
});
const unknownRecordSchema = z.record(z.unknown());
const stringMapSchema = z.record(z.string());
const basicAuthSchema = z.object({
  mode: authModeSchema.optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});
const bearerAuthSchema = z.object({
  mode: authModeSchema.optional(),
  token: z.string().optional(),
});
const apiKeyAuthSchema = z.object({
  mode: authModeSchema.optional(),
  header: z.string(),
  value: z.string().optional(),
});

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

  const parsedRecord = stringMapSchema.safeParse(value);
  if (!parsedRecord.success) {
    const issue = parsedRecord.error.issues[0];
    const keyPath = issue?.path[0];
    if (typeof keyPath === "string") {
      return Result.err(new Error(`Tool source ${fieldName}.${keyPath} must be a string`));
    }
    return Result.err(new Error(`Tool source ${fieldName} must be a map of strings`));
  }

  const record = parsedRecord.data;
  if (Object.keys(record).length === 0) {
    return Result.ok(undefined);
  }

  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    normalized[normalizedKey] = rawValue;
  }

  return Result.ok(Object.keys(normalized).length > 0 ? normalized : undefined);
}

function normalizeApprovalMode(
  value: unknown,
  fieldName: string,
): Result<ToolApprovalMode | undefined, Error> {
  if (value === undefined) return Result.ok(undefined);

  const parsed = approvalModeSchema.safeParse(value);
  if (parsed.success) {
    return Result.ok(parsed.data);
  }

  return Result.err(new Error(`Tool source ${fieldName} must be 'auto' or 'required'`));
}

function normalizeOverrides(
  value: unknown,
  fieldName: string,
): Result<Record<string, { approval?: ToolApprovalMode }> | undefined, Error> {
  if (value === undefined) return Result.ok(undefined);

  const rawRecord = unknownRecordSchema.safeParse(value);
  if (!rawRecord.success) {
    return Result.err(new Error(`Tool source ${fieldName} must be an object`));
  }

  const raw = rawRecord.data;
  if (Object.keys(raw).length === 0) {
    return Result.ok(undefined);
  }

  const normalized: Record<string, { approval?: ToolApprovalMode }> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = rawKey.trim();
    if (!key) continue;

    const parsedEntry = overrideEntrySchema.safeParse(rawValue);
    if (!parsedEntry.success) {
      return Result.err(new Error(`Tool source ${fieldName}.${key}.approval must be 'auto' or 'required'`));
    }

    normalized[key] = parsedEntry.data.approval ? { approval: parsedEntry.data.approval } : {};
  }

  return Result.ok(Object.keys(normalized).length > 0 ? normalized : undefined);
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

  if (authType === "basic") {
    const parsed = basicAuthSchema.safeParse(auth);
    if (!parsed.success) {
      return Result.err(new Error("Tool source auth.mode must be 'static', 'workspace', or 'actor'"));
    }

    return Result.ok({
      type: "basic",
      mode: parsed.data.mode,
      username: optionalTrimmedString(parsed.data.username),
      password: optionalTrimmedString(parsed.data.password),
    });
  }

  if (authType === "bearer") {
    const parsed = bearerAuthSchema.safeParse(auth);
    if (!parsed.success) {
      return Result.err(new Error("Tool source auth.mode must be 'static', 'workspace', or 'actor'"));
    }

    return Result.ok({
      type: "bearer",
      mode: parsed.data.mode,
      token: optionalTrimmedString(parsed.data.token),
    });
  }

  if (authType === "apiKey") {
    const parsed = apiKeyAuthSchema.safeParse(auth);
    if (!parsed.success) {
      const headerIssue = parsed.error.issues.some((issue) => issue.path[0] === "header");
      if (headerIssue) {
        return Result.err(new Error("Tool source auth.header is required"));
      }
      return Result.err(new Error("Tool source auth.mode must be 'static', 'workspace', or 'actor'"));
    }

    const headerResult = requiredTrimmedString(parsed.data.header, "auth.header");
    if (headerResult.isErr()) {
      return headerResult;
    }

    return Result.ok({
      type: "apiKey",
      mode: parsed.data.mode,
      header: headerResult.value,
      value: optionalTrimmedString(parsed.data.value),
    });
  }

  return Result.err(new Error(`Unsupported tool source auth.type '${authType}'`));
}

function normalizeSpec(
  value: unknown,
): Result<string | Record<string, unknown>, Error> {
  const stringSpec = z.string().safeParse(value);
  if (stringSpec.success) {
    const trimmed = stringSpec.data.trim();
    if (!trimmed) {
      return Result.err(new Error("Tool source spec is required"));
    }
    return Result.ok(trimmed);
  }

  const specObjectResult = unknownRecordSchema.safeParse(value);
  if (!specObjectResult.success) {
    return Result.err(new Error("Tool source spec must be a non-empty string or object"));
  }

  const specObject = specObjectResult.data;
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
  const configResult = unknownRecordSchema.safeParse(rawConfig);
  if (!configResult.success) {
    return Result.err(new Error("Tool source config must be an object"));
  }
  const config = configResult.data;

  if (type === "mcp") {
    const urlResult = requiredTrimmedString(config.url, "url");
    if (urlResult.isErr()) {
      return urlResult;
    }

    const transportResult = config.transport === undefined
      ? Result.ok(undefined)
      : (() => {
          const parsed = mcpTransportSchema.safeParse(config.transport);
          return parsed.success
            ? Result.ok(parsed.data)
            : Result.err(new Error("Tool source transport must be 'sse' or 'streamable-http'"));
        })();
    if (transportResult.isErr()) {
      return Result.err(new Error("Tool source transport must be 'sse' or 'streamable-http'"));
    }
    const transport = transportResult.value;

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

    const schemaResult = unknownRecordSchema.safeParse(config.schema);
    const schema = schemaResult.success ? schemaResult.data : {};

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

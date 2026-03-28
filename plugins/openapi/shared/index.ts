import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import {
  SecretRefSchema,
  StringMapSchema,
} from "@executor/platform-sdk/schema";

export const OpenApiConnectionAuthSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("bearer"),
    tokenSecretRef: SecretRefSchema,
    headerName: Schema.NullOr(Schema.String),
    prefix: Schema.NullOr(Schema.String),
  }),
);

export const OpenApiConnectInputSchema = Schema.Struct({
  name: Schema.String,
  specUrl: Schema.String,
  baseUrl: Schema.NullOr(Schema.String),
  auth: OpenApiConnectionAuthSchema,
});

export const OpenApiSourceConfigPayloadSchema = OpenApiConnectInputSchema;

export const OpenApiUpdateSourceInputSchema = Schema.Struct({
  sourceId: Schema.String,
  config: OpenApiSourceConfigPayloadSchema,
});

export const OpenApiSourceConfigSchema = Schema.Struct({
  specUrl: Schema.String,
  baseUrl: Schema.NullOr(Schema.String),
  authStrategy: Schema.Literal("none", "bearer"),
  documentHash: Schema.String,
});

export const OpenApiStoredSourceDataSchema = Schema.Struct({
  specUrl: Schema.String,
  baseUrl: Schema.NullOr(Schema.String),
  auth: OpenApiConnectionAuthSchema,
  defaultHeaders: Schema.NullOr(StringMapSchema),
  etag: Schema.NullOr(Schema.String),
  lastSyncAt: Schema.NullOr(Schema.Number),
});

export const OpenApiPreviewRequestSchema = Schema.Struct({
  specUrl: Schema.String,
});

export const OpenApiPreviewSecuritySchemeSchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("apiKey", "http", "oauth2", "openIdConnect", "unknown"),
  placement: Schema.NullOr(Schema.String),
  scheme: Schema.NullOr(Schema.String),
});

export const OpenApiPreviewResponseSchema = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  baseUrl: Schema.NullOr(Schema.String),
  namespace: Schema.NullOr(Schema.String),
  operationCount: Schema.Number,
  securitySchemes: Schema.Array(OpenApiPreviewSecuritySchemeSchema),
  warnings: Schema.Array(Schema.String),
});

export type OpenApiConnectionAuth = typeof OpenApiConnectionAuthSchema.Type;
export type OpenApiConnectInput = typeof OpenApiConnectInputSchema.Type;
export type OpenApiSourceConfigPayload =
  typeof OpenApiSourceConfigPayloadSchema.Type;
export type OpenApiSourceConfig = typeof OpenApiSourceConfigSchema.Type;
export type OpenApiStoredSourceData = typeof OpenApiStoredSourceDataSchema.Type;
export type OpenApiPreviewRequest = typeof OpenApiPreviewRequestSchema.Type;
export type OpenApiPreviewSecurityScheme =
  typeof OpenApiPreviewSecuritySchemeSchema.Type;
export type OpenApiPreviewResponse = typeof OpenApiPreviewResponseSchema.Type;
export type OpenApiUpdateSourceInput =
  typeof OpenApiUpdateSourceInputSchema.Type;

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const namespaceFromUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.trim().toLowerCase();
    if (!hostname) {
      return null;
    }

    const parts = hostname.split(".").filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    const candidate = (parts.length >= 2 ? parts[parts.length - 2] : parts[0])?.trim();
    return candidate && candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
};

const slugifyName = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : null;
};

export const deriveOpenApiNamespace = (input: {
  specUrl: string;
  title?: string | null;
}): string | null => slugifyName(input.title ?? null) ?? namespaceFromUrl(input.specUrl);

const parseDocument = (text: string): unknown => {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("The OpenAPI document is empty.");
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  return YAML.parse(trimmed);
};

const deriveBaseUrl = (document: JsonRecord, specUrl: string): string | null => {
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const firstServer = asRecord(servers[0]);
  const rawUrl = asString(firstServer?.url);
  if (rawUrl === null) {
    return null;
  }

  try {
    return new URL(rawUrl, specUrl).toString();
  } catch {
    return rawUrl;
  }
};

const previewSecuritySchemes = (document: JsonRecord): Array<OpenApiPreviewSecurityScheme> => {
  const components = asRecord(document.components);
  const securitySchemes = asRecord(components?.securitySchemes);
  if (!securitySchemes) {
    return [];
  }

  return Object.entries(securitySchemes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, rawScheme]) => {
      const scheme = asRecord(rawScheme);
      const rawKind = asString(scheme?.type);
      const kind =
        rawKind === "apiKey" ||
        rawKind === "http" ||
        rawKind === "oauth2" ||
        rawKind === "openIdConnect"
          ? rawKind
          : "unknown";

      return {
        name,
        kind,
        placement: asString(scheme?.in),
        scheme: asString(scheme?.scheme),
      } satisfies OpenApiPreviewSecurityScheme;
    });
};

const countOperations = (document: JsonRecord): number => {
  const paths = asRecord(document.paths);
  if (paths === null) {
    return 0;
  }

  const methodNames = new Set([
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
    "trace",
  ]);

  let count = 0;
  for (const pathItem of Object.values(paths)) {
    const pathRecord = asRecord(pathItem);
    if (pathRecord === null) {
      continue;
    }

    for (const key of Object.keys(pathRecord)) {
      if (methodNames.has(key.toLowerCase())) {
        count += 1;
      }
    }
  }

  return count;
};

export const previewOpenApiDocument = async (
  input: OpenApiPreviewRequest,
): Promise<OpenApiPreviewResponse> => {
  const response = await fetch(input.specUrl);
  if (!response.ok) {
    throw new Error(`Failed fetching spec: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const parsed = parseDocument(text);
  const document = asRecord(parsed);
  if (document === null) {
    throw new Error("The fetched document is not a valid OpenAPI object.");
  }

  const info = asRecord(document.info);
  const warnings: string[] = [];
  const title = asString(info?.title);

  const openapiVersion = asString(document.openapi) ?? asString(document.swagger);
  if (openapiVersion === null) {
    warnings.push("The document does not declare an OpenAPI/Swagger version.");
  }

  const baseUrl = deriveBaseUrl(document, input.specUrl);
  if (baseUrl === null) {
    warnings.push("No server URL was found in the document.");
  }

  return {
    title,
    version: asString(info?.version),
    baseUrl,
    namespace: deriveOpenApiNamespace({
      specUrl: input.specUrl,
      title,
    }),
    operationCount: countOperations(document),
    securitySchemes: previewSecuritySchemes(document),
    warnings,
  };
};

export const decodeOpenApiStoredSourceData = (
  value: unknown,
): Effect.Effect<OpenApiStoredSourceData, Error, never> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(OpenApiStoredSourceDataSchema)(value),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

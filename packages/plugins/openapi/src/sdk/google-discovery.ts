// Converts Google Discovery documents directly into OpenAPI 3.x. Public
// Discovery converters currently target Swagger 2.0 or a broad conversion
// pipeline; this adapter emits the shape Executor parses while preserving
// Executor-specific tool ids and query semantics.
import { Effect, Option, Schema, SchemaGetter } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { OpenApiParseError } from "./errors";
import {
  oauth2ClientIdSlot,
  oauth2ClientSecretSlot,
  oauth2ConnectionSlot,
} from "./source-contracts";
import type { OAuth2SourceConfig } from "./types";
import type { SpecFetchCredentials } from "./parse";

const DISCOVERY_SERVICE_HOST = "https://www.googleapis.com/discovery/v1/apis";

const TextOption = Schema.OptionFromOptional(Schema.Trim).pipe(
  Schema.decode({
    decode: SchemaGetter.transform((value) => Option.filter(value, (text) => text.length > 0)),
    encode: SchemaGetter.transform((value) => value),
  }),
  Schema.withDecodingDefaultType(Effect.succeed(Option.none())),
);
const TextArray = Schema.optional(Schema.Array(Schema.String)).pipe(
  Schema.withDecodingDefaultType(Effect.succeed([] as string[])),
);
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const UnknownRecordWithDefault = Schema.optional(UnknownRecord).pipe(
  Schema.withDecodingDefaultType(Effect.succeed({})),
);

const DiscoveryParameter = Schema.Struct({
  type: Schema.optional(Schema.String),
  description: TextOption,
  properties: UnknownRecordWithDefault,
  items: Schema.optional(Schema.Unknown),
  additionalProperties: Schema.optional(Schema.Union([Schema.Boolean, Schema.Unknown])),
  enum: TextArray,
  format: Schema.optional(Schema.String),
  readOnly: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  $ref: Schema.optional(Schema.String),
  location: Schema.optional(Schema.Literals(["path", "query", "header"])),
  required: Schema.optional(Schema.Boolean),
  repeated: Schema.optional(Schema.Boolean),
});
type DiscoveryParameter = typeof DiscoveryParameter.Type;

const DiscoveryRef = Schema.Struct({
  $ref: Schema.optional(Schema.String),
});

const DiscoveryMethod = Schema.Struct({
  id: TextOption,
  description: TextOption,
  httpMethod: Schema.optional(Schema.String),
  path: TextOption,
  parameters: UnknownRecordWithDefault,
  request: Schema.optional(DiscoveryRef),
  response: Schema.optional(DiscoveryRef),
  scopes: TextArray,
});
type DiscoveryMethod = typeof DiscoveryMethod.Type;

const DiscoveryResource = Schema.Struct({
  methods: UnknownRecordWithDefault,
  resources: UnknownRecordWithDefault,
});

const DiscoveryDocument = Schema.Struct({
  name: TextOption,
  version: TextOption,
  title: TextOption,
  rootUrl: TextOption,
  servicePath: Schema.optional(Schema.Trim).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("")),
  ),
  parameters: UnknownRecordWithDefault,
  methods: UnknownRecordWithDefault,
  resources: UnknownRecordWithDefault,
  schemas: UnknownRecordWithDefault,
  auth: Schema.optional(
    Schema.Struct({
      oauth2: Schema.optional(
        Schema.Struct({
          scopes: Schema.optional(
            Schema.Record(
              Schema.String,
              Schema.Struct({
                description: TextOption,
              }),
            ),
          ).pipe(Schema.withDecodingDefaultType(Effect.succeed({}))),
        }),
      ),
    }),
  ),
});
type DiscoveryDocument = typeof DiscoveryDocument.Type;

export interface GoogleDiscoveryOpenApiConversion {
  readonly specText: string;
  readonly baseUrl: string;
  readonly title: string;
  readonly service: string;
  readonly version: string;
  readonly oauth2?: OAuth2SourceConfig;
}

const decodeDiscoveryDocument = Schema.decodeUnknownSync(DiscoveryDocument);
const decodeDiscoveryParameter = Schema.decodeUnknownSync(DiscoveryParameter);
const decodeDiscoveryMethod = Schema.decodeUnknownSync(DiscoveryMethod);
const decodeDiscoveryResource = Schema.decodeUnknownSync(DiscoveryResource);
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const normalizeDiscoveryUrl = (discoveryUrl: string): string => {
  const trimmed = discoveryUrl.trim();
  if (!URL.canParse(trimmed)) return trimmed;
  const parsed = new URL(trimmed);
  if (parsed.pathname !== "/$discovery/rest") return trimmed;
  const version = parsed.searchParams.get("version")?.trim();
  if (!version) return trimmed;
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(".googleapis.com")) return trimmed;
  const rawService = host.slice(0, -".googleapis.com".length);
  const service =
    rawService === "calendar-json"
      ? "calendar"
      : rawService.endsWith("-json")
        ? rawService.slice(0, -5)
        : rawService;
  return service ? `${DISCOVERY_SERVICE_HOST}/${service}/${version}/rest` : trimmed;
};

export const isGoogleDiscoveryUrl = (url: string): boolean => {
  const trimmed = url.trim();
  if (!URL.canParse(trimmed)) return false;
  const parsed = new URL(trimmed);
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith("googleapis.com")) return false;
  return parsed.pathname.includes("/discovery/") || parsed.pathname.includes("$discovery");
};

export const fetchGoogleDiscoveryDocument = Effect.fn("OpenApi.fetchGoogleDiscoveryDocument")(
  function* (discoveryUrl: string, credentials?: SpecFetchCredentials) {
    const client = yield* HttpClient.HttpClient;
    const requestUrl = new URL(discoveryUrl);
    for (const [name, value] of Object.entries(credentials?.queryParams ?? {})) {
      requestUrl.searchParams.set(name, value);
    }
    let request = HttpClientRequest.get(requestUrl.toString()).pipe(
      HttpClientRequest.setHeader("Accept", "application/json, */*"),
    );
    for (const [name, value] of Object.entries(credentials?.headers ?? {})) {
      request = HttpClientRequest.setHeader(request, name, value);
    }
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to fetch Google Discovery document",
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new OpenApiParseError({
        message: `Failed to fetch Google Discovery document: HTTP ${response.status}`,
      });
    }
    return yield* response.text.pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to read Google Discovery document body",
          }),
      ),
    );
  },
);

const schemaRef = (name: string) => `#/$defs/${name}`;

const discoverySchemaToJsonSchema = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return {};
  const schema = raw as Record<string, unknown>;
  if (typeof schema.$ref === "string") return { $ref: schemaRef(schema.$ref) };

  const out: Record<string, unknown> = {};
  for (const key of ["description", "format", "readOnly", "default", "enum"]) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }

  if (schema.type === "array") {
    return { ...out, type: "array", items: discoverySchemaToJsonSchema(schema.items) };
  }

  const properties = schema.properties;
  if (
    schema.type === "object" ||
    (properties && typeof properties === "object" && !Array.isArray(properties)) ||
    schema.additionalProperties !== undefined
  ) {
    const convertedProperties =
      properties && typeof properties === "object" && !Array.isArray(properties)
        ? Object.fromEntries(
            Object.entries(properties).map(([name, value]) => [
              name,
              discoverySchemaToJsonSchema(value),
            ]),
          )
        : undefined;
    return {
      ...out,
      type: "object",
      ...(convertedProperties && Object.keys(convertedProperties).length > 0
        ? { properties: convertedProperties }
        : {}),
      ...(Array.isArray(schema.required) && schema.required.length > 0
        ? { required: schema.required }
        : {}),
      ...(schema.additionalProperties === undefined
        ? {}
        : {
            additionalProperties:
              typeof schema.additionalProperties === "boolean"
                ? schema.additionalProperties
                : discoverySchemaToJsonSchema(schema.additionalProperties),
          }),
    };
  }

  return typeof schema.type === "string" && schema.type !== "any"
    ? { ...out, type: schema.type }
    : out;
};

const parameterSchema = (parameter: DiscoveryParameter): unknown => {
  const base = discoverySchemaToJsonSchema(parameter);
  return parameter.repeated
    ? {
        type: "array",
        items: base,
      }
    : base;
};

const methodToolPath = (service: string, methodId: string): string =>
  methodId.startsWith(`${service}.`) ? methodId.slice(service.length + 1) : methodId;

const collectMethods = (resource: unknown): DiscoveryMethod[] => {
  const decoded = decodeDiscoveryResource(resource);
  const direct = Object.values(decoded.methods ?? {}).map((raw) => decodeDiscoveryMethod(raw));
  const nested = Object.values(decoded.resources ?? {}).flatMap(collectMethods);
  return [...direct, ...nested];
};

const discoveryScopes = (document: DiscoveryDocument): Record<string, string> =>
  Object.fromEntries(
    Object.entries(document.auth?.oauth2?.scopes ?? {}).map(([scope, value]) => [
      scope,
      Option.getOrElse(value.description, () => ""),
    ]),
  );

export const convertGoogleDiscoveryToOpenApi = Effect.fn("OpenApi.convertGoogleDiscovery")(
  function* (input: { readonly discoveryUrl: string; readonly documentText: string }) {
    const parsed = yield* parseJson(input.documentText).pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to parse Google Discovery document",
          }),
      ),
    );
    const document = yield* Effect.try({
      try: () => decodeDiscoveryDocument(parsed),
      catch: () =>
        new OpenApiParseError({
          message: "Failed to decode Google Discovery document",
        }),
    });

    const service = Option.getOrUndefined(document.name);
    const version = Option.getOrUndefined(document.version);
    const rootUrl = Option.getOrUndefined(document.rootUrl);
    if (!service || !version || !rootUrl) {
      return yield* new OpenApiParseError({
        message: "Google Discovery document is missing one of: name, version, rootUrl",
      });
    }

    const baseUrl = new URL(document.servicePath || "", rootUrl).toString();
    const title = Option.getOrElse(document.title, () => `${service} ${version}`);
    const paths: Record<string, Record<string, unknown>> = {};
    const allMethods = [
      ...Object.values(document.methods ?? {}).map((raw) => decodeDiscoveryMethod(raw)),
      ...Object.values(document.resources ?? {}).flatMap(collectMethods),
    ];

    for (const method of allMethods) {
      const methodId = Option.getOrUndefined(method.id);
      const pathTemplate = Option.getOrUndefined(method.path);
      if (!methodId || !pathTemplate || !method.httpMethod) continue;

      const toolPath = methodToolPath(service, methodId);
      const path = pathTemplate.startsWith("/") ? pathTemplate : `/${pathTemplate}`;
      const mergedParameters = new Map<string, DiscoveryParameter>();
      for (const [name, raw] of Object.entries(document.parameters ?? {})) {
        const parameter = decodeDiscoveryParameter(raw);
        if (parameter.location) mergedParameters.set(name, parameter);
      }
      for (const [name, raw] of Object.entries(method.parameters ?? {})) {
        const parameter = decodeDiscoveryParameter(raw);
        if (parameter.location) mergedParameters.set(name, parameter);
      }
      const methodScopes = method.scopes ?? [];

      paths[path] ??= {};
      paths[path]![method.httpMethod.toLowerCase()] = {
        operationId: toolPath,
        "x-executor-toolPath": toolPath,
        description: Option.getOrUndefined(method.description),
        parameters: [...mergedParameters.entries()].map(([name, parameter]) => ({
          name,
          in: parameter.location,
          required: parameter.location === "path" ? true : parameter.required === true,
          description: Option.getOrUndefined(parameter.description),
          schema: parameterSchema(parameter),
          ...(parameter.location === "query"
            ? { style: "form", explode: parameter.repeated === true }
            : {}),
        })),
        ...(method.request?.$ref
          ? {
              requestBody: {
                required: false,
                content: {
                  "application/json": {
                    schema: { $ref: schemaRef(method.request.$ref) },
                  },
                },
              },
            }
          : {}),
        responses: {
          "200": {
            description: "Successful response",
            content: {
              "application/json": {
                schema: method.response?.$ref ? { $ref: schemaRef(method.response.$ref) } : {},
              },
            },
          },
        },
        ...(methodScopes.length > 0 ? { security: [{ googleOAuth2: methodScopes }] } : {}),
        "x-google-scopes": methodScopes,
      };
    }

    const scopes = discoveryScopes(document);
    const securitySchemeName = "googleOAuth2";
    const oauth2: OAuth2SourceConfig | undefined =
      Object.keys(scopes).length > 0
        ? {
            kind: "oauth2",
            securitySchemeName,
            flow: "authorizationCode",
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
            issuerUrl: "https://accounts.google.com",
            tokenUrl: "https://oauth2.googleapis.com/token",
            clientIdSlot: oauth2ClientIdSlot(securitySchemeName),
            clientSecretSlot: oauth2ClientSecretSlot(securitySchemeName),
            connectionSlot: oauth2ConnectionSlot(securitySchemeName),
            scopes: Object.keys(scopes),
          }
        : undefined;

    const spec = {
      openapi: "3.1.0",
      info: {
        title,
        version,
      },
      servers: [{ url: baseUrl }],
      paths,
      components: {
        schemas: Object.fromEntries(
          Object.entries(document.schemas ?? {}).map(([name, schema]) => [
            name,
            discoverySchemaToJsonSchema(schema),
          ]),
        ),
        ...(oauth2
          ? {
              securitySchemes: {
                googleOAuth2: {
                  type: "oauth2",
                  flows: {
                    authorizationCode: {
                      authorizationUrl: oauth2.authorizationUrl,
                      tokenUrl: oauth2.tokenUrl,
                      scopes,
                    },
                  },
                },
              },
            }
          : {}),
      },
      ...(oauth2 ? { security: [{ googleOAuth2: oauth2.scopes }] } : {}),
      "x-executor-origin": {
        kind: "googleDiscovery",
        discoveryUrl: normalizeDiscoveryUrl(input.discoveryUrl),
        service,
        version,
      },
    };

    return {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      specText: JSON.stringify(spec),
      baseUrl,
      title,
      service,
      version,
      oauth2,
    };
  },
);

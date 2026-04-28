import { Effect, Option, Schema } from "effect";

import { GoogleDiscoveryParseError } from "./errors";
import {
  GoogleDiscoveryHttpMethod,
  GoogleDiscoveryManifest,
  GoogleDiscoveryManifestMethod,
  GoogleDiscoveryMethodBinding,
  GoogleDiscoveryParameter,
  GoogleDiscoveryParameterLocation,
} from "./types";

type JsonObject = Record<string, unknown>;

const TrimmedString = Schema.String.pipe(Schema.compose(Schema.Trim));
const Text = TrimmedString.pipe(Schema.compose(Schema.NonEmptyTrimmedString));
const TextOption = Schema.optionalWith(Schema.OptionFromNonEmptyTrimmedString, {
  default: () => Option.none(),
});
const TextArray = Schema.optionalWith(Schema.Array(Text), {
  default: () => [] as string[],
});
const UnknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const UnknownRecordWithDefault = Schema.optionalWith(UnknownRecord, {
  default: () => ({}),
});

const DiscoveryHttpMethodInput = Schema.optional(
  Schema.String.pipe(
    Schema.compose(Schema.Trim),
    Schema.compose(Schema.Lowercase),
    Schema.compose(GoogleDiscoveryHttpMethod),
  ),
);

const DiscoveryParameterLocationInput = Schema.optional(
  Schema.String.pipe(
    Schema.compose(Schema.Trim),
    Schema.compose(Schema.Lowercase),
    Schema.compose(GoogleDiscoveryParameterLocation),
  ),
);

const DiscoveryDefaultValue = Schema.Union(Schema.String, Schema.Number, Schema.Boolean);

const DiscoverySchemaModel = Schema.Struct({
  type: Schema.optional(
    Schema.String.pipe(Schema.compose(Schema.Trim), Schema.compose(Schema.Lowercase)),
  ),
  description: TextOption,
  properties: UnknownRecordWithDefault,
  items: Schema.optional(Schema.Unknown),
  additionalProperties: Schema.optional(Schema.Union(Schema.Boolean, Schema.Unknown)),
  enum: TextArray,
  format: Schema.optional(Text),
  readOnly: Schema.optional(Schema.Boolean),
  default: Schema.optional(DiscoveryDefaultValue),
  $ref: Schema.optional(Text),
  required: TextArray,
});
type DiscoverySchema = typeof DiscoverySchemaModel.Type;

const DiscoveryParameterModel = Schema.Struct({
  type: Schema.optional(
    Schema.String.pipe(Schema.compose(Schema.Trim), Schema.compose(Schema.Lowercase)),
  ),
  description: TextOption,
  properties: UnknownRecordWithDefault,
  items: Schema.optional(Schema.Unknown),
  additionalProperties: Schema.optional(Schema.Union(Schema.Boolean, Schema.Unknown)),
  enum: TextArray,
  format: Schema.optional(Text),
  readOnly: Schema.optional(Schema.Boolean),
  default: Schema.optional(DiscoveryDefaultValue),
  $ref: Schema.optional(Text),
  location: DiscoveryParameterLocationInput,
  required: Schema.optional(Schema.Boolean),
  repeated: Schema.optional(Schema.Boolean),
});
type DiscoveryParameter = typeof DiscoveryParameterModel.Type;

const DiscoveryRefModel = Schema.Struct({
  $ref: Schema.optional(Text),
});

const DiscoveryMethodModel = Schema.Struct({
  id: TextOption,
  description: TextOption,
  httpMethod: DiscoveryHttpMethodInput,
  path: TextOption,
  parameters: UnknownRecordWithDefault,
  request: Schema.optional(DiscoveryRefModel),
  response: Schema.optional(DiscoveryRefModel),
  scopes: TextArray,
});
type DiscoveryMethod = typeof DiscoveryMethodModel.Type;

const DiscoveryResourceModel = Schema.Struct({
  methods: UnknownRecordWithDefault,
  resources: UnknownRecordWithDefault,
});

const DiscoveryDocumentModel = Schema.Struct({
  name: TextOption,
  version: TextOption,
  title: TextOption,
  rootUrl: TextOption,
  servicePath: Schema.optionalWith(TrimmedString, { default: () => "" }),
  parameters: UnknownRecordWithDefault,
  methods: UnknownRecordWithDefault,
  resources: UnknownRecordWithDefault,
  schemas: UnknownRecordWithDefault,
  auth: Schema.optional(
    Schema.Struct({
      oauth2: Schema.optional(
        Schema.Struct({
          scopes: Schema.optionalWith(
            Schema.Record({
              key: Schema.String,
              value: Schema.Struct({
                description: TextOption,
              }),
            }),
            { default: () => ({}) },
          ),
        }),
      ),
    }),
  ),
});
type DiscoveryDocument = typeof DiscoveryDocumentModel.Type;

// The Schema.TaggedError version of GoogleDiscoveryParseError no longer
// carries a `cause` field — it would leak raw decoder internals over the
// wire. The decoder failure still shows up on the Effect cause chain for
// server-side logging; the client only sees the user-facing `message`.
const toParseError = (message: string, _cause: unknown) =>
  new GoogleDiscoveryParseError({ message });

const decodeUnknownWith =
  <A>(
    message: string,
    decode: (value: unknown) => A,
  ): ((value: unknown) => Effect.Effect<A, GoogleDiscoveryParseError>) =>
  (value) =>
    Effect.try({
      try: () => decode(value),
      catch: (error) => toParseError(message, error),
    });

const decodeDiscoveryDocument = decodeUnknownWith(
  "Failed to decode Google Discovery document",
  Schema.decodeUnknownSync(DiscoveryDocumentModel),
);

const decodeDiscoveryDocumentJson = decodeUnknownWith(
  "Failed to parse Google Discovery document",
  Schema.decodeUnknownSync(Schema.parseJson(DiscoveryDocumentModel)),
);

const decodeDiscoverySchema = decodeUnknownWith(
  "Failed to decode Google Discovery schema",
  Schema.decodeUnknownSync(DiscoverySchemaModel),
);

const decodeDiscoveryParameter = decodeUnknownWith(
  "Failed to decode Google Discovery parameter",
  Schema.decodeUnknownSync(DiscoveryParameterModel),
);

const decodeDiscoveryMethod = decodeUnknownWith(
  "Failed to decode Google Discovery method",
  Schema.decodeUnknownSync(DiscoveryMethodModel),
);

const decodeDiscoveryResource = decodeUnknownWith(
  "Failed to decode Google Discovery resource",
  Schema.decodeUnknownSync(DiscoveryResourceModel),
);

const schemaRef = (name: string) => `#/$defs/${name}`;

const toJsonSchemaSeed = (input: {
  type: DiscoverySchema["type"];
  description: DiscoverySchema["description"];
  properties: DiscoverySchema["properties"];
  items: DiscoverySchema["items"];
  additionalProperties: DiscoverySchema["additionalProperties"];
  enum: DiscoverySchema["enum"];
  format: DiscoverySchema["format"];
  readOnly: DiscoverySchema["readOnly"];
  default: DiscoverySchema["default"];
  $ref: DiscoverySchema["$ref"];
  required: DiscoverySchema["required"];
}): DiscoverySchema => ({
  type: input.type,
  description: input.description,
  properties: input.properties,
  items: input.items,
  additionalProperties: input.additionalProperties,
  enum: input.enum,
  format: input.format,
  readOnly: input.readOnly,
  default: input.default,
  $ref: input.$ref,
  required: input.required,
});

const discoverySchemaToJsonSchema = (
  schema: DiscoverySchema,
): Effect.Effect<unknown, GoogleDiscoveryParseError> =>
  Effect.gen(function* () {
    const ref = schema.$ref;
    if (ref) {
      return { $ref: schemaRef(ref) };
    }

    const description = Option.getOrUndefined(schema.description);
    const base: Record<string, unknown> = {
      ...(description ? { description } : {}),
      ...(schema.format ? { format: schema.format } : {}),
      ...(schema.enum.length > 0 ? { enum: schema.enum } : {}),
      ...(schema.readOnly === true ? { readOnly: true } : {}),
      ...(schema.default !== undefined ? { default: schema.default } : {}),
    };

    if (schema.type === "array") {
      return {
        ...base,
        type: "array",
        items: yield* googleSchemaToJsonSchema(schema.items),
      };
    }

    const properties = schema.properties;
    const additionalProperties = schema.additionalProperties;
    if (
      schema.type === "object" ||
      Object.keys(properties).length > 0 ||
      additionalProperties !== undefined
    ) {
      const convertedProperties = Object.fromEntries(
        yield* Effect.forEach(Object.entries(properties), ([name, property]) =>
          googleSchemaToJsonSchema(property).pipe(
            Effect.map((jsonSchema) => [name, jsonSchema] as const),
          ),
        ),
      );

      const convertedAdditionalProperties =
        additionalProperties === undefined
          ? undefined
          : additionalProperties === true
            ? true
            : yield* googleSchemaToJsonSchema(additionalProperties);

      return {
        ...base,
        type: "object",
        ...(Object.keys(convertedProperties).length > 0 ? { properties: convertedProperties } : {}),
        ...(schema.required.length > 0 ? { required: schema.required } : {}),
        ...(convertedAdditionalProperties !== undefined
          ? { additionalProperties: convertedAdditionalProperties }
          : {}),
      };
    }

    if (
      schema.type === "boolean" ||
      schema.type === "integer" ||
      schema.type === "number" ||
      schema.type === "string"
    ) {
      return { ...base, type: schema.type };
    }

    if (schema.type === "any") return base;

    return Object.keys(base).length > 0 ? base : {};
  });

const googleSchemaToJsonSchema = (
  rawSchema: unknown,
): Effect.Effect<unknown, GoogleDiscoveryParseError> =>
  rawSchema === undefined
    ? Effect.succeed({})
    : decodeDiscoverySchema(rawSchema).pipe(Effect.flatMap(discoverySchemaToJsonSchema));

const parameterToJsonSchema = (
  parameter: DiscoveryParameter,
): Effect.Effect<unknown, GoogleDiscoveryParseError> =>
  parameter.repeated === true
    ? discoverySchemaToJsonSchema(
        toJsonSchemaSeed({
          type: parameter.type,
          description: parameter.description,
          properties: parameter.properties,
          items: parameter.items,
          additionalProperties: parameter.additionalProperties,
          enum: parameter.enum,
          format: parameter.format,
          readOnly: parameter.readOnly,
          default: parameter.default,
          $ref: parameter.$ref,
          required: [],
        }),
      ).pipe(
        Effect.map((items) => ({
          type: "array",
          items,
        })),
      )
    : discoverySchemaToJsonSchema(
        toJsonSchemaSeed({
          type: parameter.type,
          description: parameter.description,
          properties: parameter.properties,
          items: parameter.items,
          additionalProperties: parameter.additionalProperties,
          enum: parameter.enum,
          format: parameter.format,
          readOnly: parameter.readOnly,
          default: parameter.default,
          $ref: parameter.$ref,
          required: [],
        }),
      );

const toToolPath = (service: string, methodId: string): string => {
  const withoutPrefix = methodId.startsWith(`${service}.`)
    ? methodId.slice(service.length + 1)
    : methodId;
  return withoutPrefix.trim();
};

const toParameter = (
  name: string,
  rawParameter: unknown,
): Effect.Effect<GoogleDiscoveryParameter | null, GoogleDiscoveryParseError> =>
  Effect.gen(function* () {
    const parameter = yield* decodeDiscoveryParameter(rawParameter);
    if (parameter.location === undefined) return null;

    return new GoogleDiscoveryParameter({
      name,
      location: parameter.location,
      required: parameter.required === true,
      repeated: parameter.repeated === true,
      description: parameter.description,
      schema: Option.some(yield* parameterToJsonSchema(parameter)),
    });
  });

const mergeParameters = (input: {
  globalParameters: Readonly<Record<string, unknown>>;
  method: DiscoveryMethod;
}): Effect.Effect<GoogleDiscoveryParameter[], GoogleDiscoveryParseError> =>
  Effect.gen(function* () {
    const merged = new Map<string, GoogleDiscoveryParameter>();

    for (const [name, parameter] of Object.entries(input.globalParameters)) {
      const converted = yield* toParameter(name, parameter);
      if (converted) merged.set(name, converted);
    }

    for (const [name, parameter] of Object.entries(input.method.parameters)) {
      const converted = yield* toParameter(name, parameter);
      if (converted) merged.set(name, converted);
    }

    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

const buildInputSchema = (input: {
  parameters: readonly GoogleDiscoveryParameter[];
  requestRef: string | undefined;
}): unknown | undefined => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const parameter of input.parameters) {
    properties[parameter.name] = Option.getOrElse(parameter.schema, () => ({
      type: "string",
    }));
    if (parameter.required) required.push(parameter.name);
  }

  if (input.requestRef) {
    properties.body = { $ref: schemaRef(input.requestRef) };
  }

  if (Object.keys(properties).length === 0) return undefined;

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
};

const extractScopes = (document: DiscoveryDocument): Record<string, string> | undefined => {
  const scopes = document.auth?.oauth2?.scopes ?? {};
  const normalized = Object.fromEntries(
    Object.entries(scopes).map(([scope, value]) => [
      scope,
      Option.getOrElse(value.description, () => ""),
    ]),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const manifestMethodFromMethod = (input: {
  service: string;
  rawMethod: unknown;
  globalParameters: Readonly<Record<string, unknown>>;
}): Effect.Effect<GoogleDiscoveryManifestMethod | null, GoogleDiscoveryParseError> =>
  Effect.gen(function* () {
    const method = yield* decodeDiscoveryMethod(input.rawMethod);
    const methodId = Option.getOrUndefined(method.id);
    const path = Option.getOrUndefined(method.path);
    if (!methodId || !path) return null;
    if (!method.httpMethod) {
      return yield* new GoogleDiscoveryParseError({
        message: `Google Discovery method '${methodId}' is missing httpMethod`,
      });
    }

    const requestRef = method.request?.$ref;
    const responseRef = method.response?.$ref;
    const parameters = yield* mergeParameters({
      globalParameters: input.globalParameters,
      method,
    });

    return new GoogleDiscoveryManifestMethod({
      toolPath: toToolPath(input.service, methodId),
      description: method.description,
      binding: new GoogleDiscoveryMethodBinding({
        method: method.httpMethod,
        pathTemplate: path,
        parameters,
        hasBody: requestRef !== undefined,
      }),
      inputSchema: Option.fromNullable(buildInputSchema({ parameters, requestRef })),
      outputSchema: Option.fromNullable(responseRef ? { $ref: schemaRef(responseRef) } : undefined),
      scopes: method.scopes,
    });
  });

const collectMethods = (input: {
  service: string;
  rawResource: unknown;
  globalParameters: Readonly<Record<string, unknown>>;
}): Effect.Effect<GoogleDiscoveryManifestMethod[], GoogleDiscoveryParseError> =>
  Effect.gen(function* () {
    const resource = yield* decodeDiscoveryResource(input.rawResource);
    const methods = yield* Effect.forEach(Object.values(resource.methods), (rawMethod) =>
      manifestMethodFromMethod({
        service: input.service,
        rawMethod,
        globalParameters: input.globalParameters,
      }),
    );
    const nested = yield* Effect.forEach(Object.values(resource.resources), (rawResource) =>
      collectMethods({
        ...input,
        rawResource,
      }),
    );

    return [...methods.flatMap((method) => (method ? [method] : [])), ...nested.flat()];
  });

export const extractGoogleDiscoveryManifest = Effect.fn("GoogleDiscovery.extractManifest")(
  function* (discoveryDocument: string | JsonObject) {
    const document =
      typeof discoveryDocument === "string"
        ? yield* decodeDiscoveryDocumentJson(discoveryDocument)
        : yield* decodeDiscoveryDocument(discoveryDocument);

    const service = Option.getOrUndefined(document.name);
    const version = Option.getOrUndefined(document.version);
    const rootUrl = Option.getOrUndefined(document.rootUrl);
    if (!service || !version || !rootUrl) {
      return yield* new GoogleDiscoveryParseError({
        message: "Google Discovery document is missing one of: name, version, rootUrl",
      });
    }

    const schemaDefinitions = Object.fromEntries(
      yield* Effect.forEach(Object.entries(document.schemas), ([name, rawSchema]) =>
        googleSchemaToJsonSchema(rawSchema).pipe(Effect.map((schema) => [name, schema] as const)),
      ),
    );

    const topLevelMethods = yield* Effect.forEach(Object.values(document.methods), (rawMethod) =>
      manifestMethodFromMethod({
        service,
        rawMethod,
        globalParameters: document.parameters,
      }),
    );

    const nestedMethods = yield* Effect.forEach(Object.values(document.resources), (rawResource) =>
      collectMethods({
        service,
        rawResource,
        globalParameters: document.parameters,
      }),
    );

    return new GoogleDiscoveryManifest({
      title: document.title,
      service,
      version,
      rootUrl,
      servicePath: document.servicePath,
      oauthScopes: Option.fromNullable(extractScopes(document)),
      schemaDefinitions,
      methods: [
        ...topLevelMethods.flatMap((method) => (method ? [method] : [])),
        ...nestedMethods.flat(),
      ].sort((a, b) => a.toolPath.localeCompare(b.toolPath)),
    });
  },
);

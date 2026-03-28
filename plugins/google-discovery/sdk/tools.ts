import {
  FetchHttpClient,
  HttpClient,
  type HttpClientResponse,
  HttpClientRequest,
} from "@effect/platform";
import {
  applyCookiePlacementsToHeaders,
  applyHttpQueryPlacementsToUrl,
  applyJsonBodyPlacements,
  standardSchemaFromJsonSchema,
  typeSignatureFromSchema,
  toTool,
  type HttpRequestPlacements,
  type ToolMetadata,
} from "@executor/codemode-core";
import { sourceCoreEffectError } from "@executor/source-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GOOGLE_DISCOVERY_SOURCE_KIND } from "@executor/plugin-google-discovery-shared";

import type {
  GoogleDiscoveryManifestMethod,
  GoogleDiscoverySchemaRefTable,
  GoogleDiscoveryToolDefinition,
} from "./types";
import {
  GoogleDiscoveryToolProviderDataSchema,
} from "./types";
import * as Either from "effect/Either";

const decodeGoogleDiscoveryToolProviderDataJson = Schema.decodeUnknownEither(
  GoogleDiscoveryToolProviderDataSchema,
);

export const googleDiscoveryProviderDataFromDefinition = (
  input: {
    service: string;
    version: string;
    rootUrl: string;
    servicePath: string;
    oauthScopes?: Readonly<Record<string, string>>;
    definition: GoogleDiscoveryManifestMethod;
  },
): typeof GoogleDiscoveryToolProviderDataSchema.Type => ({
    kind: GOOGLE_DISCOVERY_SOURCE_KIND,
    service: input.service,
    version: input.version,
    toolId: input.definition.toolId,
    rawToolId: input.definition.rawToolId,
    methodId: input.definition.methodId,
    group: input.definition.group,
    leaf: input.definition.leaf,
    invocation: {
      method: input.definition.method,
      path: input.definition.path,
      flatPath: input.definition.flatPath,
      rootUrl: input.rootUrl,
      servicePath: input.servicePath,
      parameters: input.definition.parameters,
      requestSchemaId: input.definition.requestSchemaId,
      responseSchemaId: input.definition.responseSchemaId,
      scopes: input.definition.scopes,
      ...(input.oauthScopes
        ? {
            scopeDescriptions: Object.fromEntries(
              input.definition.scopes.flatMap((scope) =>
                input.oauthScopes?.[scope] !== undefined
                  ? [[scope, input.oauthScopes[scope]!]]
                  : [],
              ),
            ),
          }
        : {}),
      supportsMediaUpload: input.definition.supportsMediaUpload,
      supportsMediaDownload: input.definition.supportsMediaDownload,
    },
  });

const decodeGoogleDiscoverySchemaRefTableJson = Schema.decodeUnknownEither(
  Schema.parseJson(
    Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
  ),
);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const normalizeCredentialPlacements = (input: {
  credentialHeaders?: Readonly<Record<string, string>>;
  credentialPlacements?: HttpRequestPlacements;
}): HttpRequestPlacements => ({
  headers: {
    ...input.credentialHeaders,
    ...input.credentialPlacements?.headers,
  },
  queryParams: input.credentialPlacements?.queryParams,
  cookies: input.credentialPlacements?.cookies,
  bodyValues: input.credentialPlacements?.bodyValues,
});

const setNestedSchemaProperty = (
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void => {
  if (path.length === 0) {
    return;
  }

  const [head, ...rest] = path;
  if (!head) {
    return;
  }

  if (rest.length === 0) {
    target[head] = value;
    return;
  }

  const next = asRecord(target[head]);
  target[head] = next;
  setNestedSchemaProperty(next, rest, value);
};

const materializeSchemaWithRefDefinitions = (input: {
  schema: unknown;
  refTable?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> => {
  if (input.schema === undefined || input.schema === null) {
    return {};
  }

  const rootSchema = asRecord(input.schema);

  if (!input.refTable || Object.keys(input.refTable).length === 0) {
    return rootSchema;
  }

  const defsRoot = asRecord(rootSchema.$defs);
  for (const [ref, value] of Object.entries(input.refTable)) {
    if (!ref.startsWith("#/$defs/")) {
      continue;
    }

    const materializedValue =
      typeof value === "string"
        ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return value;
          }
        })()
        : value;

    const path = ref
      .slice("#/$defs/".length)
      .split("/")
      .filter((segment) => segment.length > 0);

    setNestedSchemaProperty(defsRoot, path, materializedValue);
  }

  return Object.keys(defsRoot).length > 0
    ? { ...rootSchema, $defs: defsRoot }
    : rootSchema;
};

const decodeResponseBody = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
    const text = yield* response.text.pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    if (text.trim().length === 0) {
      return null;
    }

    if (contentType.includes("application/json") || contentType.includes("+json")) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }

    return text;
  });

const stringValuesFromParameter = (
  value: unknown,
  repeated: boolean,
): string[] => {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    const normalized = value
      .flatMap((entry) =>
        entry === undefined || entry === null ? [] : [String(entry)],
      );
    return repeated ? normalized : [normalized.join(",")];
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  return [JSON.stringify(value)];
};

const replacePathParameters = (input: {
  pathTemplate: string;
  args: Record<string, unknown>;
  parameters: ReadonlyArray<GoogleDiscoveryManifestMethod["parameters"][number]>;
}): string =>
  input.pathTemplate.replaceAll(/\{([^}]+)\}/g, (_, name: string) => {
    const parameter = input.parameters.find(
      (entry) => entry.location === "path" && entry.name === name,
    );
    const rawValue = input.args[name];
    if ((rawValue === undefined || rawValue === null) && parameter?.required) {
      throw new Error(`Missing required path parameter: ${name}`);
    }

    const values = stringValuesFromParameter(rawValue, false);
    if (values.length === 0) {
      return "";
    }

    return encodeURIComponent(values[0]!);
  });

const resolveBaseUrl = (input: {
  rootUrl: string;
  servicePath: string;
  baseUrl?: string | undefined;
}): string => {
  if (input.baseUrl) {
    return new URL(input.baseUrl).toString();
  }

  return new URL(input.servicePath || "", input.rootUrl).toString();
};

const buildGoogleDiscoveryRequest = (input: {
  definition: GoogleDiscoveryToolDefinition;
  args: Record<string, unknown>;
  defaultHeaders: Readonly<Record<string, string>>;
  credentialPlacements: HttpRequestPlacements;
  baseUrl?: string | undefined;
  providerData: typeof GoogleDiscoveryToolProviderDataSchema.Type;
}): {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
} => {
  const providerData = decodeGoogleDiscoveryToolProviderDataJson(input.providerData);
  if (Either.isLeft(providerData)) {
    throw new Error("Invalid Google Discovery provider data");
  }

  const invocation = providerData.right.invocation;
  const resolvedPath = replacePathParameters({
    pathTemplate: invocation.path,
    args: input.args,
    parameters: input.definition.parameters,
  });
  const url = new URL(
    resolvedPath.replace(/^\//, ""),
    resolveBaseUrl({
      rootUrl: invocation.rootUrl,
      servicePath: invocation.servicePath,
      baseUrl: input.baseUrl,
    }),
  );
  const headers: Record<string, string> = {
    ...input.defaultHeaders,
  };

  for (const parameter of input.definition.parameters) {
    if (parameter.location === "path") {
      continue;
    }

    const rawValue = input.args[parameter.name];
    if ((rawValue === undefined || rawValue === null) && parameter.required) {
      throw new Error(`Missing required ${parameter.location} parameter: ${parameter.name}`);
    }

    const values = stringValuesFromParameter(rawValue, parameter.repeated);
    if (values.length === 0) {
      continue;
    }

    switch (parameter.location) {
      case "query":
        for (const value of values) {
          url.searchParams.append(parameter.name, value);
        }
        break;
      case "header":
        headers[parameter.name] = parameter.repeated ? values.join(",") : values[0]!;
        break;
    }
  }

  const urlWithAuth = applyHttpQueryPlacementsToUrl({
    url,
    queryParams: input.credentialPlacements.queryParams,
  });
  const headersWithCookies = applyCookiePlacementsToHeaders({
    headers,
    cookies: input.credentialPlacements.cookies,
  });
  for (const [key, value] of Object.entries(input.credentialPlacements.headers ?? {})) {
    headersWithCookies[key] = value;
  }

  let body: string | undefined;
  if (input.definition.requestSchemaId !== null) {
    const rawBody = input.args.body;
    const bodyValues = input.credentialPlacements.bodyValues ?? {};
    const hasBodyValues = Object.keys(bodyValues).length > 0;
    if (rawBody !== undefined || hasBodyValues) {
      body = JSON.stringify(
        applyJsonBodyPlacements({
          body: rawBody !== undefined ? rawBody : {},
          bodyValues,
          label: `${input.definition.method.toUpperCase()} ${input.definition.path}`,
        }),
      );
      if (!("content-type" in headersWithCookies)) {
        headersWithCookies["content-type"] = "application/json";
      }
    }
  }

  return {
    method: input.definition.method.toUpperCase(),
    url: urlWithAuth,
    headers: headersWithCookies,
    ...(body !== undefined ? { body } : {}),
  };
};

export type CreateGoogleDiscoveryToolFromDefinitionInput = {
  definition: GoogleDiscoveryToolDefinition;
  service: string;
  version: string;
  rootUrl: string;
  servicePath: string;
  oauthScopes?: Readonly<Record<string, string>>;
  path: string;
  sourceKey: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  credentialHeaders?: Readonly<Record<string, string>>;
  credentialPlacements?: HttpRequestPlacements;
  schemaRefTable?: Readonly<GoogleDiscoverySchemaRefTable>;
  baseUrl?: string;
  httpClientLayer?: Layer.Layer<HttpClient.HttpClient, never, never>;
};

export type GoogleDiscoveryToolPresentation = {
  inputTypePreview: string;
  outputTypePreview: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  providerData: typeof GoogleDiscoveryToolProviderDataSchema.Type;
};

export const buildGoogleDiscoveryToolPresentation = (input: {
  manifest: {
    service: string;
    versionName: string;
    rootUrl: string;
    servicePath: string;
    oauthScopes?: Readonly<Record<string, string>>;
    schemaRefTable?: Readonly<GoogleDiscoverySchemaRefTable>;
  };
  definition: GoogleDiscoveryToolDefinition;
}): GoogleDiscoveryToolPresentation => {
  const refTable = Object.fromEntries(
    Object.entries(input.manifest.schemaRefTable ?? {}).map(([ref, value]) => {
      try {
        return [ref, JSON.parse(value) as unknown];
      } catch {
        return [ref, value];
      }
    }),
  );
  const inputSchema =
    input.definition.inputSchema === undefined
      ? undefined
      : materializeSchemaWithRefDefinitions({
          schema: input.definition.inputSchema,
          refTable,
        });
  const outputSchema =
    input.definition.outputSchema === undefined
      ? undefined
      : materializeSchemaWithRefDefinitions({
          schema: input.definition.outputSchema,
          refTable,
        });

  return {
    inputTypePreview: typeSignatureFromSchema(inputSchema, "unknown", Infinity),
    outputTypePreview: typeSignatureFromSchema(outputSchema, "unknown", Infinity),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    providerData: googleDiscoveryProviderDataFromDefinition({
      service: input.manifest.service,
      version: input.manifest.versionName,
      rootUrl: input.manifest.rootUrl,
      servicePath: input.manifest.servicePath,
      oauthScopes: input.manifest.oauthScopes,
      definition: input.definition,
    }),
  };
};

export const createGoogleDiscoveryToolFromDefinition = (
  input: CreateGoogleDiscoveryToolFromDefinitionInput,
) => {
  const presentation = buildGoogleDiscoveryToolPresentation({
    manifest: {
      service: input.service,
      versionName: input.version,
      rootUrl: input.rootUrl,
      servicePath: input.servicePath,
      oauthScopes: input.oauthScopes,
      schemaRefTable: input.schemaRefTable,
    },
    definition: input.definition,
  });
  const providerData = presentation.providerData;
  const credentialPlacements = normalizeCredentialPlacements({
    credentialHeaders: input.credentialHeaders,
    credentialPlacements: input.credentialPlacements,
  });
  const httpClientLayer = input.httpClientLayer ?? FetchHttpClient.layer;

  const metadata: ToolMetadata = {
    interaction: input.definition.method === "get" || input.definition.method === "head"
      ? "auto"
      : "required",
    contract: {
      inputTypePreview: presentation.inputTypePreview,
      outputTypePreview: presentation.outputTypePreview,
      ...(presentation.inputSchema !== undefined
        ? { inputSchema: presentation.inputSchema }
        : {}),
      ...(presentation.outputSchema !== undefined
        ? { outputSchema: presentation.outputSchema }
        : {}),
    },
    sourceKey: input.sourceKey,
    pluginKind: GOOGLE_DISCOVERY_SOURCE_KIND,
    pluginData: providerData,
  };

  return toTool({
    tool: {
      description: input.definition.description ?? undefined,
      inputSchema: standardSchemaFromJsonSchema(presentation.inputSchema ?? {}),
      execute: (args: unknown) =>
        Effect.runPromise(
          (Effect.gen(function* () {
            const request = buildGoogleDiscoveryRequest({
              definition: input.definition,
              args: asRecord(args),
              defaultHeaders: input.defaultHeaders ?? {},
              credentialPlacements,
              baseUrl: input.baseUrl,
              providerData,
            });
            let clientRequest = HttpClientRequest.make(
              request.method as Parameters<typeof HttpClientRequest.make>[0],
            )(request.url, {
              headers: request.headers,
            });

            if (request.body !== undefined) {
              clientRequest = HttpClientRequest.bodyText(
                clientRequest,
                request.body,
                request.headers["content-type"],
              );
            }

            const client = yield* HttpClient.HttpClient;
            const response = yield* client.execute(clientRequest).pipe(
              Effect.mapError((cause) =>
                cause instanceof Error ? cause : new Error(String(cause)),
              ),
            );
            const body = yield* decodeResponseBody(response);

            if (response.status < 200 || response.status >= 300) {
              return yield* sourceCoreEffectError("google-discovery/tools", 
                  `Google Discovery request failed with HTTP ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
                );
            }

            return body;
          }).pipe(Effect.provide(httpClientLayer)) as Effect.Effect<
            unknown,
            Error,
            never
          >),
        ),
    },
    metadata,
  });
};

export {
  decodeGoogleDiscoverySchemaRefTableJson,
};

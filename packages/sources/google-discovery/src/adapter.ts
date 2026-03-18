import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import {
  applyCookiePlacementsToHeaders,
  applyHttpQueryPlacementsToUrl,
  applyJsonBodyPlacements,
} from "@executor/codemode-core";
import {
  compileGoogleDiscoveryToolDefinitions,
  extractGoogleDiscoveryManifest,
} from "./document";
import { detectGoogleDiscoverySource } from "./discovery";
import { buildGoogleDiscoveryToolPresentation } from "./tools";
import {
  createGoogleDiscoveryCatalogFragment,
  type GoogleDiscoveryCatalogOperationInput,
} from "./catalog";
import { GoogleDiscoveryLocalConfigBindingSchema } from "./local-config";
import {
  GoogleDiscoveryToolProviderDataSchema,
  type GoogleDiscoveryToolManifest,
  type GoogleDiscoveryToolProviderData,
} from "./types";
import {
  ConnectHttpAuthSchema,
  ConnectHttpImportAuthSchema,
  ConnectOauthClientSchema,
  createSourceCatalogSyncResult,
  decodeBindingConfig,
  decodeExecutableBindingPayload,
  decodeSourceBindingPayload,
  emptySourceBindingState,
  encodeBindingConfig,
  isSourceCredentialRequiredError,
  OptionalNullableStringSchema,
  SourceCredentialRequiredError,
  StringMapSchema,
  WorkspaceOauthClientIdSchema,
  createCatalogImportMetadata,
  EXECUTABLE_BINDING_VERSION,
  sourceCoreEffectError,
  type Source,
  type SourceAdapter,
} from "@executor/source-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const GoogleDiscoveryConnectPayloadSchema = Schema.extend(
  ConnectHttpImportAuthSchema,
  Schema.Struct({
    kind: Schema.Literal("google_discovery"),
    service: Schema.Trim.pipe(Schema.nonEmptyString()),
    version: Schema.Trim.pipe(Schema.nonEmptyString()),
    discoveryUrl: Schema.optional(
      Schema.NullOr(Schema.Trim.pipe(Schema.nonEmptyString())),
    ),
    scopes: Schema.optional(
      Schema.Array(Schema.Trim.pipe(Schema.nonEmptyString())),
    ),
    workspaceOauthClientId: Schema.optional(
      Schema.NullOr(WorkspaceOauthClientIdSchema),
    ),
    oauthClient: ConnectOauthClientSchema,
    name: OptionalNullableStringSchema,
    namespace: OptionalNullableStringSchema,
    auth: Schema.optional(ConnectHttpAuthSchema),
  }),
);

const GoogleDiscoveryExecutorAddInputSchema =
  GoogleDiscoveryConnectPayloadSchema;

const GoogleDiscoveryBindingConfigSchema = Schema.Struct({
  service: Schema.Trim.pipe(Schema.nonEmptyString()),
  version: Schema.Trim.pipe(Schema.nonEmptyString()),
  discoveryUrl: Schema.Trim.pipe(Schema.nonEmptyString()),
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
  scopes: Schema.optional(
    Schema.Array(Schema.Trim.pipe(Schema.nonEmptyString())),
  ),
});

const GoogleDiscoverySourceBindingPayloadSchema = Schema.Struct({
  service: Schema.String,
  version: Schema.String,
  discoveryUrl: Schema.optional(Schema.String),
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
  scopes: Schema.optional(Schema.Array(Schema.String)),
});

type GoogleDiscoveryBindingConfig =
  typeof GoogleDiscoveryBindingConfigSchema.Type;

const GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION = 1;
const bindingHasAnyField = (
  value: unknown,
  fields: readonly string[],
): boolean =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));

const defaultGoogleDiscoveryUrl = (service: string, version: string): string =>
  `https://www.googleapis.com/discovery/v1/apis/${encodeURIComponent(service)}/${encodeURIComponent(version)}/rest`;

const googleDiscoveryBindingConfigFromSource = (
  source: Pick<Source, "id" | "bindingVersion" | "binding">,
): Effect.Effect<GoogleDiscoveryBindingConfig, Error, never> =>
  Effect.gen(function* () {
    if (
      bindingHasAnyField(source.binding, [
        "transport",
        "queryParams",
        "headers",
        "specUrl",
      ])
    ) {
      return yield* sourceCoreEffectError("google-discovery/adapter", 
          "Google Discovery sources cannot define MCP or OpenAPI binding fields",
        );
    }

    const bindingConfig = yield* decodeSourceBindingPayload({
      sourceId: source.id,
      label: "Google Discovery",
      version: source.bindingVersion,
      expectedVersion: GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION,
      schema: GoogleDiscoverySourceBindingPayloadSchema,
      value: source.binding,
      allowedKeys: [
        "service",
        "version",
        "discoveryUrl",
        "defaultHeaders",
        "scopes",
      ],
    });

    const service = bindingConfig.service.trim();
    const version = bindingConfig.version.trim();
    if (service.length === 0 || version.length === 0) {
      return yield* sourceCoreEffectError("google-discovery/adapter", "Google Discovery sources require service and version");
    }

    const explicitDiscoveryUrl =
      typeof bindingConfig.discoveryUrl === "string" &&
      bindingConfig.discoveryUrl.trim().length > 0
        ? bindingConfig.discoveryUrl.trim()
        : null;

    return {
      service,
      version,
      discoveryUrl:
        explicitDiscoveryUrl ?? defaultGoogleDiscoveryUrl(service, version),
      defaultHeaders: bindingConfig.defaultHeaders ?? null,
      scopes: (bindingConfig.scopes ?? [])
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    } satisfies GoogleDiscoveryBindingConfig;
  });

const fetchGoogleDiscoveryDocumentWithHeaders = (input: {
  url: string;
  headers?: Readonly<Record<string, string>>;
  queryParams?: Readonly<Record<string, string>>;
  cookies?: Readonly<Record<string, string>>;
}): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(input.url).pipe(
      HttpClientRequest.setHeaders({
        ...input.headers,
        ...(input.cookies
          ? {
              cookie: Object.entries(input.cookies)
                .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
                .join("; "),
            }
          : {}),
      }),
    );
    const response = yield* client
      .execute(request)
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );

    if (response.status === 401 || response.status === 403) {
      return yield* new SourceCredentialRequiredError(
          "import",
          `Google Discovery fetch requires credentials (status ${response.status})`,
        );
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* sourceCoreEffectError("google-discovery/adapter", 
          `Google Discovery fetch failed with status ${response.status}`,
        );
    }

    return yield* response.text.pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringValuesFromParameter = (
  value: unknown,
  repeated: boolean,
): string[] => {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    const normalized = value.flatMap((entry) =>
      entry === undefined || entry === null ? [] : [String(entry)],
    );
    return repeated ? normalized : [normalized.join(",")];
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [String(value)];
  }

  return [JSON.stringify(value)];
};

const replacePathParameters = (input: {
  pathTemplate: string;
  args: Record<string, unknown>;
  parameters: ReadonlyArray<
    GoogleDiscoveryToolProviderData["invocation"]["parameters"][number]
  >;
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

const resolveGoogleDiscoveryBaseUrl = (input: {
  providerData: GoogleDiscoveryToolProviderData;
  baseUrl?: string;
}): string => {
  if (input.baseUrl) {
    return new URL(input.baseUrl).toString();
  }

  return new URL(
    input.providerData.invocation.servicePath || "",
    input.providerData.invocation.rootUrl,
  ).toString();
};

const responseHeadersRecord = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
};

const decodeResponseBody = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const text = await response.text();

  if (text.trim().length === 0) {
    return null;
  }

  if (
    contentType.includes("application/json") ||
    contentType.includes("+json")
  ) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return text;
};

const googleDiscoveryCatalogOperationFromDefinition = (input: {
  manifest: Parameters<typeof compileGoogleDiscoveryToolDefinitions>[0];
  definition: ReturnType<typeof compileGoogleDiscoveryToolDefinitions>[number];
}): GoogleDiscoveryCatalogOperationInput => {
  const presentation = buildGoogleDiscoveryToolPresentation({
    manifest: input.manifest,
    definition: input.definition,
  });

  return {
    toolId: input.definition.toolId,
    title: input.definition.name,
    description: input.definition.description,
    effect:
      input.definition.method === "get" || input.definition.method === "head"
        ? "read"
        : input.definition.method === "delete"
          ? "delete"
          : "write",
    inputSchema: presentation.inputSchema,
    outputSchema: presentation.outputSchema,
    providerData: presentation.providerData as GoogleDiscoveryToolProviderData,
  };
};

/**
 * Google's API server enforces a "most restrictive matching scope" policy: when
 * a narrow scope (e.g. gmail.metadata) is granted alongside a broader scope
 * (e.g. gmail.readonly), the server may restrict behaviour to the narrow scope.
 *
 * For Gmail, this means having gmail.metadata in the grant blocks the `q`
 * parameter on messages.list and prevents reading message bodies, even when
 * gmail.readonly or gmail.modify are also granted.
 *
 * To avoid this, we compute the maximal non-redundant scope set from the
 * discovery document's per-method scope declarations. A scope is "subsumed" if
 * every method that accepts it also accepts some other scope in the set — meaning
 * the other scope is strictly broader. Subsumed scopes are dropped so that
 * Google's server never picks the narrower one.
 */
const computeMaximalScopes = (
  manifest: GoogleDiscoveryToolManifest,
): ReadonlyArray<string> => {
  const topLevelScopes = Object.keys(manifest.oauthScopes ?? {});
  if (topLevelScopes.length === 0) return [];

  // Build a map of scope -> set of method IDs that accept it
  const scopeToMethods = new Map<string, Set<string>>();
  for (const scope of topLevelScopes) {
    scopeToMethods.set(scope, new Set());
  }
  for (const method of manifest.methods) {
    for (const scope of method.scopes) {
      scopeToMethods.get(scope)?.add(method.methodId);
    }
  }

  // A scope is subsumed if there exists another scope whose method set is a
  // strict superset of this scope's method set. Remove subsumed scopes.
  const maximal = topLevelScopes.filter((scope) => {
    const methods = scopeToMethods.get(scope);
    if (!methods || methods.size === 0) return true; // keep scopes not used by any method
    return !topLevelScopes.some((other) => {
      if (other === scope) return false;
      const otherMethods = scopeToMethods.get(other);
      if (!otherMethods || otherMethods.size <= methods.size) return false;
      // Check if `other` is a strict superset of `scope`
      for (const m of methods) {
        if (!otherMethods.has(m)) return false;
      }
      return true;
    });
  });

  return maximal;
};

const googleDiscoveryOauth2SetupConfig = (source: Source) =>
  Effect.gen(function* () {
    const bindingConfig = yield* googleDiscoveryBindingConfigFromSource(source);
    const configuredScopes = bindingConfig.scopes ?? [];
    const manifest = yield* fetchGoogleDiscoveryDocumentWithHeaders({
      url: bindingConfig.discoveryUrl,
      headers: bindingConfig.defaultHeaders ?? undefined,
    }).pipe(
      Effect.flatMap((document) =>
        extractGoogleDiscoveryManifest(source.name, document),
      ),
      Effect.catchAll(() => Effect.succeed(null)),
    );
    const discoveryScopes = manifest ? computeMaximalScopes(manifest) : [];
    const scopes =
      discoveryScopes.length > 0
        ? [...new Set([...discoveryScopes, ...configuredScopes])]
        : configuredScopes;

    if (scopes.length === 0) {
      return null;
    }

    return {
      providerKey: "google_workspace",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scopes,
      headerName: "Authorization",
      prefix: "Bearer ",
      clientAuthentication: "client_secret_post" as const,
      authorizationParams: {
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
      },
    };
  });

export const googleDiscoverySourceAdapter = {
  key: "google_discovery",
  displayName: "Google Discovery",
  catalogKind: "imported",
  connectStrategy: "direct",
  credentialStrategy: "credential_managed",
  bindingConfigVersion: GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION,
  providerKey: "google_workspace",
  defaultImportAuthPolicy: "reuse_runtime",
  connectPayloadSchema: GoogleDiscoveryConnectPayloadSchema,
  executorAddInputSchema: GoogleDiscoveryExecutorAddInputSchema,
  executorAddHelpText: [
    "service is the Discovery service name, e.g. sheets or drive. version is the API version, e.g. v4 or v3.",
  ],
  executorAddInputSignatureWidth: 420,
  localConfigBindingSchema: GoogleDiscoveryLocalConfigBindingSchema,
  localConfigBindingFromSource: (source) =>
    Effect.runSync(
      Effect.map(
        googleDiscoveryBindingConfigFromSource(source),
        (bindingConfig) => ({
          service: bindingConfig.service,
          version: bindingConfig.version,
          discoveryUrl: bindingConfig.discoveryUrl,
          defaultHeaders: bindingConfig.defaultHeaders ?? null,
          scopes: bindingConfig.scopes,
        }),
      ),
    ),
  serializeBindingConfig: (source) =>
    encodeBindingConfig({
      adapterKey: "google_discovery",
      version: GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION,
      payloadSchema: GoogleDiscoveryBindingConfigSchema,
      payload: Effect.runSync(googleDiscoveryBindingConfigFromSource(source)),
    }),
  deserializeBindingConfig: ({ id, bindingConfigJson }) =>
    Effect.map(
      decodeBindingConfig({
        sourceId: id,
        label: "Google Discovery",
        adapterKey: "google_discovery",
        version: GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION,
        payloadSchema: GoogleDiscoveryBindingConfigSchema,
        value: bindingConfigJson,
      }),
      ({ version, payload }) => ({
        version,
        payload: {
          service: payload.service,
          version: payload.version,
          discoveryUrl: payload.discoveryUrl,
          defaultHeaders: payload.defaultHeaders ?? null,
          scopes: payload.scopes ?? [],
        },
      }),
    ),
  bindingStateFromSource: (source) =>
    Effect.map(
      googleDiscoveryBindingConfigFromSource(source),
      (bindingConfig) => ({
        ...emptySourceBindingState,
        defaultHeaders: bindingConfig.defaultHeaders ?? null,
      }),
    ),
  sourceConfigFromSource: (source) =>
    Effect.runSync(
      Effect.map(
        googleDiscoveryBindingConfigFromSource(source),
        (bindingConfig) => ({
          kind: "google_discovery",
          service: bindingConfig.service,
          version: bindingConfig.version,
          discoveryUrl: bindingConfig.discoveryUrl,
          defaultHeaders: bindingConfig.defaultHeaders,
          scopes: bindingConfig.scopes,
        }),
      ),
    ),
  validateSource: (source) =>
    Effect.gen(function* () {
      const bindingConfig =
        yield* googleDiscoveryBindingConfigFromSource(source);
      return {
        ...source,
        bindingVersion: GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION,
        binding: {
          service: bindingConfig.service,
          version: bindingConfig.version,
          discoveryUrl: bindingConfig.discoveryUrl,
          defaultHeaders: bindingConfig.defaultHeaders ?? null,
          scopes: [...(bindingConfig.scopes ?? [])],
        },
      };
    }),
  shouldAutoProbe: (source) =>
    source.enabled &&
    (source.status === "draft" || source.status === "probing"),
  discoveryPriority: ({ normalizedUrl }) =>
    normalizedUrl.includes("$discovery/rest") || normalizedUrl.includes("/discovery/v1/apis/")
      ? 500
      : 300,
  detectSource: ({ normalizedUrl, headers }) =>
    detectGoogleDiscoverySource({
      normalizedUrl,
      headers,
    }),
  syncCatalog: ({ source, resolveAuthMaterialForSlot }) =>
    Effect.gen(function* () {
      const bindingConfig =
        yield* googleDiscoveryBindingConfigFromSource(source);
      const auth = yield* resolveAuthMaterialForSlot("import");
      const discoveryDocument = yield* fetchGoogleDiscoveryDocumentWithHeaders({
        url: bindingConfig.discoveryUrl,
        headers: {
          ...bindingConfig.defaultHeaders,
          ...auth.headers,
        },
        cookies: auth.cookies,
        queryParams: auth.queryParams,
      }).pipe(
        Effect.mapError((cause) =>
          isSourceCredentialRequiredError(cause)
            ? cause
            : new Error(
                `Failed fetching Google Discovery document for ${source.id}: ${cause.message}`,
              ),
        ),
      );
      const manifest = yield* extractGoogleDiscoveryManifest(
        source.name,
        discoveryDocument,
      );
      const definitions = compileGoogleDiscoveryToolDefinitions(manifest);
      const now = Date.now();

      return createSourceCatalogSyncResult({
        fragment: createGoogleDiscoveryCatalogFragment({
          source,
          documents: [
            {
              documentKind: "google_discovery",
              documentKey: bindingConfig.discoveryUrl,
              contentText: discoveryDocument,
              fetchedAt: now,
            },
          ],
          operations: definitions.map((definition) =>
            googleDiscoveryCatalogOperationFromDefinition({
              manifest,
              definition,
            }),
          ),
        }),
        importMetadata: createCatalogImportMetadata({
          source,
          adapterKey: "google_discovery",
        }),
        sourceHash: manifest.sourceHash,
      });
    }),
  getOauth2SetupConfig: ({ source }) =>
    googleDiscoveryOauth2SetupConfig(source),
  normalizeOauthClientInput: (input) =>
    Effect.succeed({
      ...input,
      redirectMode: input.redirectMode ?? "loopback",
    }),
  invoke: (input) =>
    Effect.tryPromise({
      try: async () => {
        const bindingConfig = Effect.runSync(
          googleDiscoveryBindingConfigFromSource(input.source),
        );
        const providerData = decodeExecutableBindingPayload({
          executableId: input.executable.id,
          label: "Google Discovery",
          version: input.executable.bindingVersion,
          expectedVersion: EXECUTABLE_BINDING_VERSION,
          schema: GoogleDiscoveryToolProviderDataSchema,
          value: input.executable.binding,
        }) as GoogleDiscoveryToolProviderData;
        const args = asRecord(input.args);
        const resolvedPath = replacePathParameters({
          pathTemplate: providerData.invocation.path,
          args,
          parameters: providerData.invocation.parameters,
        });
        const url = new URL(
          resolvedPath.replace(/^\//, ""),
          resolveGoogleDiscoveryBaseUrl({
            providerData,
            baseUrl: input.source.endpoint,
          }),
        );
        const headers: Record<string, string> = {
          ...bindingConfig.defaultHeaders,
        };

        for (const parameter of providerData.invocation.parameters) {
          if (parameter.location === "path") {
            continue;
          }

          const rawValue = args[parameter.name];
          if (
            (rawValue === undefined || rawValue === null) &&
            parameter.required
          ) {
            throw new Error(
              `Missing required ${parameter.location} parameter: ${parameter.name}`,
            );
          }

          const values = stringValuesFromParameter(
            rawValue,
            parameter.repeated,
          );
          if (values.length === 0) {
            continue;
          }

          if (parameter.location === "query") {
            for (const value of values) {
              url.searchParams.append(parameter.name, value);
            }
            continue;
          }

          if (parameter.location === "header") {
            headers[parameter.name] = parameter.repeated
              ? values.join(",")
              : values[0]!;
          }
        }

        const requestUrl = applyHttpQueryPlacementsToUrl({
          url,
          queryParams: input.auth.queryParams,
        });
        const requestHeaders = applyCookiePlacementsToHeaders({
          headers: {
            ...headers,
            ...input.auth.headers,
          },
          cookies: input.auth.cookies,
        });

        let body: string | undefined;
        const hasBodyValues = Object.keys(input.auth.bodyValues).length > 0;
        if (
          providerData.invocation.requestSchemaId !== null &&
          (args.body !== undefined || hasBodyValues)
        ) {
          body = JSON.stringify(
            applyJsonBodyPlacements({
              body: args.body !== undefined ? args.body : {},
              bodyValues: input.auth.bodyValues,
              label: `${providerData.invocation.method.toUpperCase()} ${providerData.invocation.path}`,
            }),
          );
          if (!("content-type" in requestHeaders)) {
            requestHeaders["content-type"] = "application/json";
          }
        }

        const response = await fetch(requestUrl.toString(), {
          method: providerData.invocation.method.toUpperCase(),
          headers: requestHeaders,
          ...(body !== undefined ? { body } : {}),
        });
        const responseBody = await decodeResponseBody(response);

        return {
          data: response.ok ? responseBody : null,
          error: response.ok ? null : responseBody,
          headers: responseHeadersRecord(response),
          status: response.status,
        };
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }),
} satisfies SourceAdapter;

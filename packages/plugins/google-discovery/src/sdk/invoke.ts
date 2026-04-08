import { Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";

import {
  type ScopeId,
  type SecretId,
  type ToolId,
  ToolInvocationError,
  ToolInvocationResult,
  type ToolInvoker,
} from "@executor/core";

import { GoogleDiscoveryInvocationError } from "./errors";
import type { GoogleDiscoveryBindingStore } from "./binding-store";
import {
  GoogleDiscoveryInvocationResult,
  GoogleDiscoveryStoredSourceData,
  type GoogleDiscoveryParameter,
} from "./types";
import { refreshAccessToken } from "./oauth";

const OAUTH_REFRESH_SKEW_MS = 60_000;

const SAFE_METHODS = new Set(["get", "head", "options"]);

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
  parameters: readonly GoogleDiscoveryParameter[];
}): string =>
  input.pathTemplate.replaceAll(/\{([^}]+)\}/g, (_, name: string) => {
    const parameter = input.parameters.find(
      (entry) => entry.location === "path" && entry.name === name,
    );
    const values = stringValuesFromParameter(input.args[name], false);
    if (values.length === 0) {
      if (parameter?.required) {
        throw new Error(`Missing required path parameter: ${name}`);
      }
      return "";
    }
    return encodeURIComponent(values[0]!);
  });

const resolveBaseUrl = (source: GoogleDiscoveryStoredSourceData): string =>
  new URL(source.servicePath || "", source.rootUrl).toString();

const isJsonContentType = (contentType: string | null | undefined): boolean => {
  if (!contentType) return false;
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized === "application/json" ||
    normalized.includes("+json") ||
    normalized.includes("json")
  );
};

const resolveOAuthAccessToken = (input: {
  sourceId: string;
  source: GoogleDiscoveryStoredSourceData;
  secrets: {
    readonly resolve: (
      secretId: SecretId,
      scopeId: ScopeId,
    ) => Effect.Effect<string, unknown>;
    readonly set: (input: {
      id: SecretId;
      scopeId: ScopeId;
      name: string;
      value: string;
      purpose?: string;
    }) => Effect.Effect<unknown, unknown>;
  };
  scopeId: ScopeId;
  bindingStore: GoogleDiscoveryBindingStore;
}): Effect.Effect<string, ToolInvocationError> =>
  Effect.gen(function* () {
    if (input.source.auth.kind !== "oauth2") {
      return "";
    }

    const auth = input.source.auth;
    const now = Date.now();
    const needsRefresh =
      auth.refreshTokenSecretId !== null &&
      auth.expiresAt !== null &&
      auth.expiresAt <= now + OAUTH_REFRESH_SKEW_MS;

    if (!needsRefresh) {
      return yield* input.secrets
        .resolve(auth.accessTokenSecretId as SecretId, input.scopeId)
        .pipe(
          Effect.mapError(
            () =>
              new ToolInvocationError({
                toolId: "" as ToolId,
                message: "Failed to resolve Google OAuth access token",
                cause: undefined,
              }),
          ),
        );
    }

    const refreshToken = yield* input.secrets
      .resolve(auth.refreshTokenSecretId as SecretId, input.scopeId)
      .pipe(
        Effect.mapError(
          () =>
            new ToolInvocationError({
              toolId: "" as ToolId,
              message: "Failed to resolve Google OAuth refresh token",
              cause: undefined,
            }),
        ),
      );

    const clientSecret =
      auth.clientSecretSecretId === null
        ? null
        : yield* input.secrets
            .resolve(auth.clientSecretSecretId as SecretId, input.scopeId)
            .pipe(
              Effect.mapError(
                () =>
                  new ToolInvocationError({
                    toolId: "" as ToolId,
                    message: "Failed to resolve Google OAuth client secret",
                    cause: undefined,
                  }),
              ),
            );

    const refreshed = yield* refreshAccessToken({
      clientId: auth.clientId,
      clientSecret,
      refreshToken,
      scopes: auth.scopes,
    }).pipe(
      Effect.mapError(
        (error) =>
          new ToolInvocationError({
            toolId: "" as ToolId,
            message: error.message,
            cause: undefined,
          }),
      ),
    );

    yield* input.secrets.set({
      id: auth.accessTokenSecretId as SecretId,
      scopeId: input.scopeId,
      name: `${input.source.name} Access Token`,
      value: refreshed.access_token,
      purpose: "google_oauth_access_token",
    }).pipe(
      Effect.mapError(
        () =>
          new ToolInvocationError({
            toolId: "" as ToolId,
            message: "Failed to persist refreshed Google OAuth access token",
            cause: undefined,
          }),
      ),
    );

    let refreshTokenSecretId = auth.refreshTokenSecretId;
    if (refreshed.refresh_token && auth.refreshTokenSecretId) {
      yield* input.secrets.set({
        id: auth.refreshTokenSecretId as SecretId,
        scopeId: input.scopeId,
        name: `${input.source.name} Refresh Token`,
        value: refreshed.refresh_token,
        purpose: "google_oauth_refresh_token",
      }).pipe(
        Effect.mapError(
          () =>
            new ToolInvocationError({
              toolId: "" as ToolId,
              message: "Failed to persist refreshed Google OAuth refresh token",
              cause: undefined,
            }),
        ),
      );
      refreshTokenSecretId = auth.refreshTokenSecretId;
    }

    const updatedSource = new GoogleDiscoveryStoredSourceData({
      ...input.source,
      auth: {
        kind: "oauth2",
        clientId: auth.clientId,
        clientSecretSecretId: auth.clientSecretSecretId,
        accessTokenSecretId: auth.accessTokenSecretId,
        refreshTokenSecretId,
        tokenType: refreshed.token_type ?? auth.tokenType,
        expiresAt:
          typeof refreshed.expires_in === "number"
            ? Date.now() + refreshed.expires_in * 1000
            : auth.expiresAt,
        scope: refreshed.scope ?? auth.scope,
        scopes: auth.scopes,
      },
    });
    yield* input.bindingStore.putSource({
      namespace: input.sourceId,
      name: input.source.name,
      config: updatedSource,
    });

    return refreshed.access_token;
  });

export const annotationsForOperation = (method: string, pathTemplate: string): {
  requiresApproval?: boolean;
  approvalDescription?: string;
} => {
  if (SAFE_METHODS.has(method.toLowerCase())) return {};
  return {
    requiresApproval: true,
    approvalDescription: `${method.toUpperCase()} ${pathTemplate}`,
  };
};

const invoke = Effect.fn("GoogleDiscovery.invoke")(function* (input: {
  method: string;
  pathTemplate: string;
  parameters: readonly GoogleDiscoveryParameter[];
  hasBody: boolean;
  source: GoogleDiscoveryStoredSourceData;
  args: Record<string, unknown>;
  authorizationHeader?: string;
}) {
  const client = yield* HttpClient.HttpClient;

  const resolvedPath = replacePathParameters({
    pathTemplate: input.pathTemplate,
    args: input.args,
    parameters: input.parameters,
  });
  const requestUrl = new URL(
    resolvedPath.replace(/^\//, ""),
    resolveBaseUrl(input.source),
  );

  for (const parameter of input.parameters) {
    if (parameter.location === "path") continue;

    const values = stringValuesFromParameter(
      input.args[parameter.name],
      parameter.repeated,
    );
    if (values.length === 0) {
      if (parameter.required) {
        return yield* new GoogleDiscoveryInvocationError({
          message: `Missing required ${parameter.location} parameter: ${parameter.name}`,
          statusCode: Option.none(),
          error: undefined,
        });
      }
      continue;
    }

    if (parameter.location === "query") {
      for (const value of values) {
        requestUrl.searchParams.append(parameter.name, value);
      }
      continue;
    }
  }

  let request = HttpClientRequest.make(
    input.method.toUpperCase() as "GET",
  )(requestUrl.toString());

  for (const parameter of input.parameters) {
    if (parameter.location !== "header") continue;
    const values = stringValuesFromParameter(
      input.args[parameter.name],
      parameter.repeated,
    );
    if (values.length === 0) continue;
    request = HttpClientRequest.setHeader(
      request,
      parameter.name,
      parameter.repeated ? values.join(",") : values[0]!,
    );
  }

  if (input.authorizationHeader) {
    request = HttpClientRequest.setHeader(
      request,
      "Authorization",
      input.authorizationHeader,
    );
  }

  if (input.hasBody && input.args.body !== undefined) {
    request = HttpClientRequest.bodyUnsafeJson(request, input.args.body);
  }

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new GoogleDiscoveryInvocationError({
          message: `HTTP request failed: ${err.message}`,
          statusCode: Option.none(),
          error: err,
        }),
    ),
  );

  const contentType = response.headers["content-type"] ?? null;
  const body =
    response.status === 204
      ? null
      : isJsonContentType(contentType)
        ? yield* response.json.pipe(Effect.catchAll(() => response.text))
        : yield* response.text;

  const ok = response.status >= 200 && response.status < 300;

  return new GoogleDiscoveryInvocationResult({
    status: response.status,
    headers: { ...response.headers },
    data: ok ? body : null,
    error: ok ? null : body,
  });
});

export const makeGoogleDiscoveryInvoker = (input: {
  readonly bindingStore: GoogleDiscoveryBindingStore;
  readonly secrets: {
    readonly resolve: (
      secretId: SecretId,
      scopeId: ScopeId,
    ) => Effect.Effect<string, unknown>;
    readonly set: (input: {
      id: SecretId;
      scopeId: ScopeId;
      name: string;
      value: string;
      purpose?: string;
    }) => Effect.Effect<unknown, unknown>;
  };
  readonly scopeId: ScopeId;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}): ToolInvoker => {
  const httpClientLayer = input.httpClientLayer ?? FetchHttpClient.layer;

  return {
    resolveAnnotations: (toolId: ToolId) =>
      Effect.gen(function* () {
        const entry = yield* input.bindingStore.get(toolId);
        if (!entry) return undefined;
        return annotationsForOperation(
          entry.binding.method,
          entry.binding.pathTemplate,
        );
      }),

    invoke: (toolId: ToolId, args: unknown) =>
      Effect.gen(function* () {
        const entry = yield* input.bindingStore.get(toolId);
        if (!entry) {
          return yield* new ToolInvocationError({
            toolId,
            message: `No Google Discovery operation found for tool "${toolId}"`,
            cause: undefined,
          });
        }

        const source = yield* input.bindingStore.getSourceConfig(entry.namespace);
        if (!source) {
          return yield* new ToolInvocationError({
            toolId,
            message: `No Google Discovery source found for "${entry.namespace}"`,
            cause: undefined,
          });
        }

        const accessToken =
          source.auth.kind === "oauth2"
            ? yield* resolveOAuthAccessToken({
                sourceId: entry.namespace,
                source,
                secrets: input.secrets,
                scopeId: input.scopeId,
                bindingStore: input.bindingStore,
              })
            : "";

        const authHeader =
          source.auth.kind === "oauth2"
            ? `${source.auth.tokenType} ${accessToken}`
            : undefined;

        const result = yield* invoke({
          method: entry.binding.method,
          pathTemplate: entry.binding.pathTemplate,
          parameters: entry.binding.parameters,
          hasBody: entry.binding.hasBody,
          source,
          args: (args ?? {}) as Record<string, unknown>,
          authorizationHeader: authHeader,
        }).pipe(Effect.provide(httpClientLayer));

        return new ToolInvocationResult({
          data: result.data,
          error: result.error,
          status: result.status,
        });
      }).pipe(
        Effect.catchAll((error) =>
          error instanceof ToolInvocationError
            ? Effect.fail(error)
            : Effect.fail(
                new ToolInvocationError({
                  toolId,
                  message:
                    error instanceof Error ? error.message : String(error),
                  cause: undefined,
                }),
              ),
        ),
      ),
  };
};

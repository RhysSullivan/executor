import { Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";

import type { PluginCtx, StorageFailure } from "@executor/sdk";

import {
  GoogleDiscoveryInvocationError,
  GoogleDiscoveryOAuthError,
} from "./errors";
import type { GoogleDiscoveryStore } from "./binding-store";
import {
  GoogleDiscoveryInvocationResult,
  type GoogleDiscoveryParameter,
  type GoogleDiscoveryStoredSourceData,
} from "./types";

const SAFE_METHODS = new Set(["get", "head", "options"]);

export const annotationsForOperation = (
  method: string,
  pathTemplate: string,
): { requiresApproval?: boolean; approvalDescription?: string } => {
  if (SAFE_METHODS.has(method.toLowerCase())) return {};
  return {
    requiresApproval: true,
    approvalDescription: `${method.toUpperCase()} ${pathTemplate}`,
  };
};

// ---------------------------------------------------------------------------
// Path / query parameter helpers (unchanged from the old invoker)
// ---------------------------------------------------------------------------

const stringValuesFromParameter = (value: unknown, repeated: boolean): string[] => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    const normalized = value.flatMap((entry) =>
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
    normalized === "application/json" || normalized.includes("+json") || normalized.includes("json")
  );
};

// ---------------------------------------------------------------------------
// HTTP request builder / executor
// ---------------------------------------------------------------------------

const performRequest = Effect.fn("GoogleDiscovery.invoke")(function* (input: {
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
  const requestUrl = new URL(resolvedPath.replace(/^\//, ""), resolveBaseUrl(input.source));

  for (const parameter of input.parameters) {
    if (parameter.location === "path") continue;
    const values = stringValuesFromParameter(input.args[parameter.name], parameter.repeated);
    if (values.length === 0) {
      if (parameter.required) {
        return yield* new GoogleDiscoveryInvocationError({
          message: `Missing required ${parameter.location} parameter: ${parameter.name}`,
          statusCode: Option.none(),
        });
      }
      continue;
    }
    if (parameter.location === "query") {
      for (const value of values) {
        requestUrl.searchParams.append(parameter.name, value);
      }
    }
  }

  let request = HttpClientRequest.make(input.method.toUpperCase() as "GET")(requestUrl.toString());

  for (const parameter of input.parameters) {
    if (parameter.location !== "header") continue;
    const values = stringValuesFromParameter(input.args[parameter.name], parameter.repeated);
    if (values.length === 0) continue;
    request = HttpClientRequest.setHeader(
      request,
      parameter.name,
      parameter.repeated ? values.join(",") : values[0]!,
    );
  }

  if (input.authorizationHeader) {
    request = HttpClientRequest.setHeader(request, "Authorization", input.authorizationHeader);
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
          cause: err,
        }),
    ),
  );

  const contentType = response.headers["content-type"] ?? null;
  const mapBodyError = Effect.mapError(
    (err: { readonly message?: string }) =>
      new GoogleDiscoveryInvocationError({
        message: `Failed to read response body: ${err.message ?? String(err)}`,
        statusCode: Option.some(response.status),
        cause: err,
      }),
  );
  const body =
    response.status === 204
      ? null
      : isJsonContentType(contentType)
        ? yield* response.json.pipe(
            Effect.catchAll(() => response.text),
            mapBodyError,
          )
        : yield* response.text.pipe(mapBodyError);

  const ok = response.status >= 200 && response.status < 300;
  return new GoogleDiscoveryInvocationResult({
    status: response.status,
    headers: { ...response.headers },
    data: ok ? body : null,
    error: ok ? null : body,
  });
});

// ---------------------------------------------------------------------------
// Entry point — called from plugin.invokeTool.
// ---------------------------------------------------------------------------

export const invokeGoogleDiscoveryTool = (input: {
  ctx: PluginCtx<GoogleDiscoveryStore>;
  toolId: string;
  /** Resolved owning scope of the tool row. */
  toolScope: string;
  args: unknown;
  httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}): Effect.Effect<
  GoogleDiscoveryInvocationResult,
  | GoogleDiscoveryInvocationError
  | GoogleDiscoveryOAuthError
  | StorageFailure
> =>
  Effect.gen(function* () {
    const entry = yield* input.ctx.storage.getBinding(input.toolId, input.toolScope);
    if (!entry) {
      return yield* Effect.fail(
        new GoogleDiscoveryInvocationError({
          message: `No Google Discovery operation found for tool "${input.toolId}"`,
          statusCode: Option.none(),
        }),
      );
    }
    const stored = yield* input.ctx.storage.getSource(entry.namespace, input.toolScope);
    if (!stored) {
      return yield* Effect.fail(
        new GoogleDiscoveryInvocationError({
          message: `No Google Discovery source found for "${entry.namespace}"`,
          statusCode: Option.none(),
        }),
      );
    }
    const source = stored.config;

    const authHeader =
      source.auth.kind === "oauth2"
        ? `Bearer ${yield* input.ctx.connections
            .accessToken(source.auth.connectionId)
            .pipe(
              Effect.mapError(
                (err) =>
                  new GoogleDiscoveryOAuthError({
                    message:
                      "message" in err
                        ? (err as { message: string }).message
                        : String(err),
                  }),
              ),
            )}`
        : undefined;

    const layer = input.httpClientLayer ?? FetchHttpClient.layer;

    return yield* performRequest({
      method: entry.binding.method,
      pathTemplate: entry.binding.pathTemplate,
      parameters: entry.binding.parameters,
      hasBody: entry.binding.hasBody,
      source,
      args: (input.args ?? {}) as Record<string, unknown>,
      authorizationHeader: authHeader,
    }).pipe(Effect.provide(layer));
  });

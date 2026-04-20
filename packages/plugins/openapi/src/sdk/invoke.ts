// ---------------------------------------------------------------------------
// Parameter serialization
//
// OpenAPI 3.x parameters can use a matrix of `style` + `explode` options
// (form, simple, matrix, label, spaceDelimited, pipeDelimited, deepObject)
// that control exactly how arrays/objects/primitives appear on the wire.
// Rather than hand-rolling the cases, this module delegates the RFC-6570
// covered styles (simple / label / matrix / form) to the `url-template`
// package (a ~4KB reference implementation of RFC 6570), and implements the
// three OpenAPI-only styles (spaceDelimited, pipeDelimited, deepObject) by
// hand. Query strings built here are appended to the request URL directly
// so Effect's UrlParams layer (which uses URLSearchParams and would break
// pipe/space/deepObject framing) never runs on top of them. Required
// parameters and request bodies are enforced up front with a clear
// OpenApiInvocationError; cookie parameters are emitted as a single
// Cookie: name=value; name2=value2 header as per RFC 6265.
// ---------------------------------------------------------------------------

import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { parseTemplate } from "url-template";

import type { StorageFailure } from "@executor/sdk";

import { OpenApiInvocationError } from "./errors";
import {
  type HeaderValue,
  type OperationBinding,
  InvocationResult,
  type OperationParameter,
} from "./types";

// ---------------------------------------------------------------------------
// Parameter reading
// ---------------------------------------------------------------------------

const CONTAINER_KEYS: Record<string, readonly string[]> = {
  path: ["path", "pathParams", "params"],
  query: ["query", "queryParams", "params"],
  header: ["headers", "header"],
  cookie: ["cookies", "cookie"],
};

const readParamValue = (args: Record<string, unknown>, param: OperationParameter): unknown => {
  const direct = args[param.name];
  if (direct !== undefined) return direct;

  for (const key of CONTAINER_KEYS[param.location] ?? []) {
    const container = args[key];
    if (typeof container === "object" && container !== null && !Array.isArray(container)) {
      const nested = (container as Record<string, unknown>)[param.name];
      if (nested !== undefined) return nested;
    }
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Style / explode helpers
// ---------------------------------------------------------------------------

type Style =
  | "simple"
  | "label"
  | "matrix"
  | "form"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";

const defaultStyle = (location: OperationParameter["location"]): Style => {
  switch (location) {
    case "path":
    case "header":
      return "simple";
    case "query":
    case "cookie":
      return "form";
  }
};

const styleFor = (param: OperationParameter): Style => {
  const raw = Option.getOrUndefined(param.style);
  if (raw === "simple" || raw === "label" || raw === "matrix" || raw === "form" ||
      raw === "spaceDelimited" || raw === "pipeDelimited" || raw === "deepObject") {
    return raw;
  }
  return defaultStyle(param.location);
};

const explodeFor = (param: OperationParameter, style: Style): boolean => {
  const override = Option.getOrUndefined(param.explode);
  if (override !== undefined) return override;
  // RFC spec default: only `form` defaults to explode=true; everything
  // else defaults to false.
  return style === "form";
};

const isObjectLike = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// url-template operators for the RFC-6570 subset of OpenAPI styles.
const rfcOperator: Partial<Record<Style, "" | "." | ";" | "?">> = {
  simple: "",
  label: ".",
  matrix: ";",
  form: "?",
};

/**
 * Build a URI-template fragment (e.g. `{?name*}`) for a single parameter
 * and expand it with the given value. Returns the encoded fragment
 * without any leading `&` — the caller stitches form-style query pieces
 * together with `&` as needed.
 */
const expandRfc = (
  style: Style,
  name: string,
  value: unknown,
  explode: boolean,
): string => {
  const op = rfcOperator[style];
  if (op === undefined) {
    throw new Error(`expandRfc called with non-RFC style: ${style}`);
  }
  const modifier = explode ? "*" : "";
  // url-template only accepts primitives / primitive arrays / flat objects
  // of primitives. Coerce numbers/booleans through as-is; leave strings
  // alone; stringify arrays/objects element-wise.
  const tpl = parseTemplate(`{${op}${name}${modifier}}`);
  return tpl.expand({ [name]: value as never });
};

// ---------------------------------------------------------------------------
// Query-string assembly
//
// For each query parameter, produce a list of already-encoded pieces like
// ["tag=a", "tag=b"] or ["user[name]=alice"]. Caller joins with `&`.
// ---------------------------------------------------------------------------

const encodeFormComponent = (s: string): string =>
  // RFC 3986 unreserved + standard form encoding — matches what
  // URLSearchParams would produce except for space (we use %20, which is
  // legal in query strings and what OpenAPI readers expect).
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

const queryPiecesForParam = (
  param: OperationParameter,
  value: unknown,
): readonly string[] => {
  const style = styleFor(param);
  const explode = explodeFor(param, style);
  const name = param.name;

  if (style === "form") {
    // Delegate to url-template: handles primitives, arrays (with explode
    // toggling between `?tag=a&tag=b` and `?tag=a,b`) and objects
    // (exploded spreads keys at top level; unexploded joins as
    // `?obj=key,val,key2,val2`).
    const expanded = expandRfc("form", name, value, explode);
    // expanded looks like "?tag=a&tag=b" or "" for empty. Strip leading ?.
    if (expanded === "") return [];
    const body = expanded.startsWith("?") ? expanded.slice(1) : expanded;
    return body === "" ? [] : body.split("&");
  }

  if (style === "spaceDelimited" || style === "pipeDelimited") {
    const sep = style === "spaceDelimited" ? "%20" : "|";
    if (Array.isArray(value)) {
      if (explode) {
        return value
          .filter((v) => v !== undefined && v !== null)
          .map((v) => `${encodeFormComponent(name)}=${encodeFormComponent(String(v))}`);
      }
      const joined = value
        .filter((v) => v !== undefined && v !== null)
        .map((v) => encodeFormComponent(String(v)))
        .join(sep);
      return joined === "" ? [] : [`${encodeFormComponent(name)}=${joined}`];
    }
    // Primitive fallback: behave like form.
    return [`${encodeFormComponent(name)}=${encodeFormComponent(String(value))}`];
  }

  if (style === "deepObject") {
    if (!isObjectLike(value)) return [];
    const out: string[] = [];
    // Emit `user[name]=alice&user[role]=admin` with the brackets left
    // literal — this is what OpenAPI generators and Rails-style servers
    // expect. `new URL(...)` accepts unencoded `[` and `]` in the
    // query component.
    const walk = (prefix: string, v: unknown) => {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) walk(`${prefix}[${i}]`, v[i]);
      } else if (isObjectLike(v)) {
        for (const [k, inner] of Object.entries(v)) {
          if (inner === undefined) continue;
          walk(`${prefix}[${encodeFormComponent(k)}]`, inner);
        }
      } else if (v !== undefined && v !== null) {
        out.push(`${prefix}=${encodeFormComponent(String(v))}`);
      }
    };
    walk(encodeFormComponent(name), value);
    return out;
  }

  // Any other style in a query slot (simple/label/matrix is unusual here
  // but spec doesn't outright forbid it) — fall back to form.
  const expanded = expandRfc("form", name, value, explode);
  if (expanded === "") return [];
  const body = expanded.startsWith("?") ? expanded.slice(1) : expanded;
  return body === "" ? [] : body.split("&");
};

// ---------------------------------------------------------------------------
// Path resolution — spec styles: simple (default), label, matrix
// ---------------------------------------------------------------------------

const pathSegmentForParam = (
  param: OperationParameter,
  value: unknown,
): string => {
  const style = styleFor(param);
  const explode = explodeFor(param, style);
  if (style === "simple" || style === "label" || style === "matrix") {
    return expandRfc(style, param.name, value, explode);
  }
  // Fall back to simple for any odd configuration.
  return expandRfc("simple", param.name, value, explode);
};

const resolvePath = Effect.fn("OpenApi.resolvePath")(function* (
  pathTemplate: string,
  args: Record<string, unknown>,
  parameters: readonly OperationParameter[],
) {
  let resolved = pathTemplate;

  for (const param of parameters) {
    if (param.location !== "path") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) {
      if (param.required) {
        return yield* new OpenApiInvocationError({
          message: `Missing required path parameter: ${param.name}`,
          statusCode: Option.none(),
        });
      }
      // Optional path param missing — strip the placeholder entirely so
      // we don't leave a literal `{foo}` on the wire. Rare in practice.
      resolved = resolved.replaceAll(`{${param.name}}`, "");
      continue;
    }
    resolved = resolved.replaceAll(
      `{${param.name}}`,
      pathSegmentForParam(param, value),
    );
  }

  // Unknown `{name}` placeholders in the template that have no matching
  // declared parameter — pull from args by name as a last resort.
  const remaining = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");

  for (const name of remaining) {
    const value = args[name];
    if (value !== undefined && value !== null) {
      resolved = resolved.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    }
  }

  const unresolved = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");

  if (unresolved.length > 0) {
    return yield* new OpenApiInvocationError({
      message: `Unresolved path parameters: ${[...new Set(unresolved)].join(", ")}`,
      statusCode: Option.none(),
    });
  }

  return resolved;
});

// ---------------------------------------------------------------------------
// Header resolution — resolves secret refs at invocation time
// ---------------------------------------------------------------------------

export const resolveHeaders = (
  headers: Record<string, HeaderValue>,
  secrets: {
    readonly get: (id: string) => Effect.Effect<string | null, StorageFailure>;
  },
): Effect.Effect<Record<string, string>, OpenApiInvocationError | StorageFailure> => {
  const entries = Object.entries(headers);
  const secretCount = entries.reduce(
    (acc, [, value]) => (typeof value === "string" ? acc : acc + 1),
    0,
  );
  return Effect.gen(function* () {
    // Fan out secret lookups: on every invocation, one or two headers
    // typically each hit the secret store. Resolving them in parallel
    // is a free wall-clock win — preserved order is only needed for
    // the final assembly, not the fetches.
    const values = yield* Effect.all(
      entries.map(([name, value]) =>
        typeof value === "string"
          ? Effect.succeed({ name, value })
          : secrets.get(value.secretId).pipe(
              Effect.flatMap((secret) =>
                secret === null
                  ? Effect.fail(
                      new OpenApiInvocationError({
                        message: `Failed to resolve secret "${value.secretId}" for header "${name}"`,
                        statusCode: Option.none(),
                      }),
                    )
                  : Effect.succeed({
                      name,
                      value: value.prefix ? `${value.prefix}${secret}` : secret,
                    }),
              ),
            ),
      ),
      { concurrency: "unbounded" },
    );
    const resolved: Record<string, string> = {};
    for (const { name, value } of values) resolved[name] = value;
    return resolved;
  }).pipe(
    Effect.withSpan("plugin.openapi.secret.resolve", {
      attributes: {
        "plugin.openapi.headers.total": entries.length,
        "plugin.openapi.headers.secret_count": secretCount,
      },
    }),
  );
};

const applyHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  headers: Record<string, string>,
): HttpClientRequest.HttpClientRequest => {
  let req = request;
  for (const [name, value] of Object.entries(headers)) {
    req = HttpClientRequest.setHeader(req, name, value);
  }
  return req;
};

// ---------------------------------------------------------------------------
// Header param serialization — OpenAPI only really supports `simple` here.
// ---------------------------------------------------------------------------

const headerValueForParam = (param: OperationParameter, value: unknown): string => {
  const style = styleFor(param);
  const explode = explodeFor(param, style);
  // RFC 6570 `simple` (no operator) produces the right thing for
  // primitives, arrays ("a,b" — simple explode is the same for arrays),
  // and objects (`k,v,k2,v2` unexploded or `k=v,k2=v2` exploded). The
  // RFC-6570 simple expansion will percent-encode space / non-ASCII;
  // that's acceptable for header values (all HTTP parsers accept
  // percent-encoded tokens here and callers typically pass ASCII).
  return expandRfc("simple", param.name, value, explode);
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const normalizeContentType = (ct: string | null | undefined): string =>
  ct?.split(";")[0]?.trim().toLowerCase() ?? "";

const isJsonContentType = (ct: string | null | undefined): boolean => {
  const normalized = normalizeContentType(ct);
  if (!normalized) return false;
  return (
    normalized === "application/json" || normalized.includes("+json") || normalized.includes("json")
  );
};

const isFormUrlEncoded = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct) === "application/x-www-form-urlencoded";

const isMultipartFormData = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct).startsWith("multipart/form-data");

// ---------------------------------------------------------------------------
// Public API — invoke a single operation
// ---------------------------------------------------------------------------

export const invoke = Effect.fn("OpenApi.invoke")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
) {
  const client = yield* HttpClient.HttpClient;

  yield* Effect.annotateCurrentSpan({
    "http.method": operation.method.toUpperCase(),
    "http.route": operation.pathTemplate,
    "plugin.openapi.method": operation.method.toUpperCase(),
    "plugin.openapi.path_template": operation.pathTemplate,
    "plugin.openapi.headers.resolved_count": Object.keys(resolvedHeaders).length,
  });

  const resolvedPath = yield* resolvePath(operation.pathTemplate, args, operation.parameters);

  // Enforce required non-path params before building the request. Path
  // params are already enforced in resolvePath.
  for (const param of operation.parameters) {
    if (param.location === "path") continue;
    if (!param.required) continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) {
      return yield* new OpenApiInvocationError({
        message: `Missing required ${param.location} parameter: ${param.name}`,
        statusCode: Option.none(),
      });
    }
  }

  // Enforce required request body similarly.
  if (Option.isSome(operation.requestBody) && operation.requestBody.value.required) {
    const bodyValue = args.body ?? args.input;
    if (bodyValue === undefined || bodyValue === null) {
      return yield* new OpenApiInvocationError({
        message: `Missing required request body`,
        statusCode: Option.none(),
      });
    }
  }

  // Build the query string using our style-aware serializer. We
  // deliberately bypass HttpClientRequest.setUrlParam (which routes
  // through URLSearchParams and would break pipe/space/deepObject
  // framing) and splice the query directly onto the URL path.
  const queryPieces: string[] = [];
  for (const param of operation.parameters) {
    if (param.location !== "query") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    queryPieces.push(...queryPiecesForParam(param, value));
  }

  const rawPath = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;
  const path = queryPieces.length > 0
    ? `${rawPath}${rawPath.includes("?") ? "&" : "?"}${queryPieces.join("&")}`
    : rawPath;

  let request = HttpClientRequest.make(operation.method.toUpperCase() as "GET")(path);

  for (const param of operation.parameters) {
    if (param.location !== "header") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    request = HttpClientRequest.setHeader(request, param.name, headerValueForParam(param, value));
  }

  // Cookie parameters — collect all of them and emit a single
  // `Cookie: name=value; name2=value2` header. Before this change we
  // silently dropped them.
  const cookieParts: string[] = [];
  for (const param of operation.parameters) {
    if (param.location !== "cookie") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    // RFC 6265 cookie-value is quite permissive; OpenAPI `form` (default)
    // with explode=false joins arrays as comma lists. Serialize as
    // `name=value` without further URL-encoding beyond what url-template
    // emits.
    const encoded = encodeFormComponent(String(value));
    cookieParts.push(`${param.name}=${encoded}`);
  }
  if (cookieParts.length > 0) {
    // Merge with any Cookie header already present in resolvedHeaders
    // (rare, but don't clobber it).
    const existing = Object.entries(resolvedHeaders).find(
      ([k]) => k.toLowerCase() === "cookie",
    );
    const merged = existing
      ? `${existing[1]}; ${cookieParts.join("; ")}`
      : cookieParts.join("; ");
    request = HttpClientRequest.setHeader(request, "Cookie", merged);
  }

  if (Option.isSome(operation.requestBody)) {
    const rb = operation.requestBody.value;
    const bodyValue = args.body ?? args.input;
    if (bodyValue !== undefined) {
      if (isJsonContentType(rb.contentType)) {
        request = HttpClientRequest.bodyUnsafeJson(request, bodyValue);
      } else if (typeof bodyValue === "string") {
        request = HttpClientRequest.bodyText(request, bodyValue, rb.contentType);
      } else if (isFormUrlEncoded(rb.contentType)) {
        request = HttpClientRequest.bodyUrlParams(
          request,
          bodyValue as Parameters<typeof HttpClientRequest.bodyUrlParams>[1],
        );
      } else if (isMultipartFormData(rb.contentType)) {
        request = HttpClientRequest.bodyFormDataRecord(
          request,
          bodyValue as Parameters<typeof HttpClientRequest.bodyFormDataRecord>[1],
        );
      } else {
        request = HttpClientRequest.bodyText(request, JSON.stringify(bodyValue), rb.contentType);
      }
    }
  }

  request = applyHeaders(request, resolvedHeaders);

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new OpenApiInvocationError({
          message: `HTTP request failed: ${err.message}`,
          statusCode: Option.none(),
          cause: err,
        }),
    ),
  );

  const status = response.status;
  yield* Effect.annotateCurrentSpan({
    "http.status_code": status,
  });
  const responseHeaders: Record<string, string> = { ...response.headers };

  const contentType = response.headers["content-type"] ?? null;
  const mapBodyError = Effect.mapError(
    (err: { readonly message?: string }) =>
      new OpenApiInvocationError({
        message: `Failed to read response body: ${err.message ?? String(err)}`,
        statusCode: Option.some(status),
        cause: err,
      }),
  );
  const responseBody: unknown =
    status === 204
      ? null
      : isJsonContentType(contentType)
        ? yield* response.json.pipe(
            Effect.catchAll(() => response.text),
            mapBodyError,
          )
        : yield* response.text.pipe(mapBodyError);

  const ok = status >= 200 && status < 300;

  return new InvocationResult({
    status,
    headers: responseHeaders,
    data: ok ? responseBody : null,
    error: ok ? null : responseBody,
  });
});

// ---------------------------------------------------------------------------
// Invoke with a provided HttpClient layer + optional baseUrl prefix
// ---------------------------------------------------------------------------

export const invokeWithLayer = (
  operation: OperationBinding,
  args: Record<string, unknown>,
  baseUrl: string,
  resolvedHeaders: Record<string, string>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
) => {
  const clientWithBaseUrl = baseUrl
    ? Layer.effect(
        HttpClient.HttpClient,
        Effect.map(
          HttpClient.HttpClient,
          HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)),
        ),
      ).pipe(Layer.provide(httpClientLayer))
    : httpClientLayer;

  return invoke(operation, args, resolvedHeaders).pipe(
    Effect.provide(clientWithBaseUrl),
    Effect.withSpan("plugin.openapi.invoke", {
      attributes: {
        "plugin.openapi.method": operation.method.toUpperCase(),
        "plugin.openapi.path_template": operation.pathTemplate,
        "plugin.openapi.base_url": baseUrl,
      },
    }),
  );
};

// ---------------------------------------------------------------------------
// Derive annotations from HTTP method
// ---------------------------------------------------------------------------

const DEFAULT_REQUIRE_APPROVAL = new Set(["post", "put", "patch", "delete"]);

export const annotationsForOperation = (
  method: string,
  pathTemplate: string,
  policy?: { readonly requireApprovalFor?: readonly string[] },
): { requiresApproval?: boolean; approvalDescription?: string } => {
  const m = method.toLowerCase();
  const requireSet = policy?.requireApprovalFor
    ? new Set(policy.requireApprovalFor.map((v) => v.toLowerCase()))
    : DEFAULT_REQUIRE_APPROVAL;
  if (!requireSet.has(m)) return {};
  return {
    requiresApproval: true,
    approvalDescription: `${method.toUpperCase()} ${pathTemplate}`,
  };
};

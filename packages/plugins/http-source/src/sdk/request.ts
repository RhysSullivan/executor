import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { HttpRequestError } from "./errors";
import type { RenderedAuth } from "./template";
import type { HttpMethod, HttpResponse } from "./types";

/* Build + issue a raw HTTP request for the http-source `request` tool. The auth
 * template's rendered headers/query (from the connection's resolved value) are
 * merged with the per-call args; the response is shaped into `HttpResponse`. */

const normalizeContentType = (ct: string | null | undefined): string =>
  ct?.split(";")[0]?.trim().toLowerCase() ?? "";

const isJsonContentType = (ct: string | null | undefined): boolean => {
  const normalized = normalizeContentType(ct);
  if (!normalized) return false;
  return normalized === "application/json" || normalized.includes("+json");
};

const joinUrl = (baseUrl: string, path: string): string => {
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return suffix.length > 0 ? `${base}/${suffix}` : base;
};

const applyBody = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
): HttpClientRequest.HttpClientRequest => {
  if (body === undefined || body === null) return request;
  if (typeof body === "string") {
    return HttpClientRequest.bodyText(request, body, "text/plain");
  }
  return HttpClientRequest.bodyJsonUnsafe(request, body);
};

export interface IssueRequestInput {
  readonly baseUrl: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  /** Headers/query the connection's auth template contributes. */
  readonly auth: RenderedAuth;
  /** Non-secret default headers from the integration config. */
  readonly defaultHeaders?: Record<string, string>;
}

const buildRequest = (input: IssueRequestInput): HttpClientRequest.HttpClientRequest => {
  const url = joinUrl(input.baseUrl, input.path);
  let request = HttpClientRequest.make(input.method)(url);

  for (const [name, value] of Object.entries(input.defaultHeaders ?? {})) {
    request = HttpClientRequest.setHeader(request, name, value);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    request = HttpClientRequest.setHeader(request, name, value);
  }
  for (const [name, value] of Object.entries(input.auth.headers)) {
    request = HttpClientRequest.setHeader(request, name, value);
  }

  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value === undefined || value === null) continue;
    request = HttpClientRequest.setUrlParam(request, name, String(value));
  }
  for (const [name, value] of Object.entries(input.auth.queryParams)) {
    request = HttpClientRequest.setUrlParam(request, name, value);
  }

  return applyBody(request, input.body);
};

/** Issue the request through a provided HttpClient layer, returning a shaped
 *  `HttpResponse` (status / headers / parsed-or-text body). */
export const issueRequest = (
  input: IssueRequestInput,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
): Effect.Effect<HttpResponse, HttpRequestError> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = buildRequest(input);

    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause: unknown) =>
          new HttpRequestError({
            message: `HTTP request to ${joinUrl(input.baseUrl, input.path)} failed`,
            cause,
          }),
      ),
    );

    const status = response.status;
    const headers: Record<string, string> = { ...response.headers };
    const contentType = response.headers["content-type"] ?? null;

    const body: unknown =
      status === 204
        ? null
        : isJsonContentType(contentType)
          ? yield* response.json.pipe(
              Effect.catch(() => response.text),
              Effect.mapError(
                (cause: unknown) =>
                  new HttpRequestError({
                    message: "Failed to read response body",
                    cause,
                  }),
              ),
            )
          : yield* response.text.pipe(
              Effect.mapError(
                (cause: unknown) =>
                  new HttpRequestError({
                    message: "Failed to read response body",
                    cause,
                  }),
              ),
            );

    return { status, headers, body };
  }).pipe(
    Effect.provide(httpClientLayer),
    Effect.withSpan("plugin.http-source.request", {
      attributes: {
        "http.method": input.method,
        "http.url": joinUrl(input.baseUrl, input.path),
      },
    }),
  );

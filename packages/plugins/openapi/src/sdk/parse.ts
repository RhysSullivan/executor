import type { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { Duration, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import YAML from "yaml";

import { OpenApiExtractionError, OpenApiParseError } from "./errors";

export type ParsedDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

// ExtractionError subclass raised from parse() for non-3.x specs
class OpenApiExtractionErrorFromParse extends OpenApiExtractionError {}

/**
 * Fetch an OpenAPI spec URL and return its body text. Uses the Effect
 * HttpClient so the caller chooses the transport via layer — in Cloudflare
 * Workers, `FetchHttpClient.layer` binds to the Workers-native `fetch` and
 * avoids json-schema-ref-parser's Node-polyfill http resolver, which hangs
 * in production. Bounded by a 20s timeout.
 */
export const fetchSpecText = Effect.fn("OpenApi.fetchSpecText")(function* (url: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("Accept", "application/json, application/yaml, text/yaml, */*"),
      ),
    )
    .pipe(
      Effect.timeout(Duration.seconds(20)),
      Effect.mapError(
        (cause) =>
          new OpenApiParseError({
            message: `Failed to fetch OpenAPI document: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* new OpenApiParseError({
      message: `Failed to fetch OpenAPI document: HTTP ${response.status}`,
    });
  }
  return yield* response.text.pipe(
    Effect.mapError(
      (cause) =>
        new OpenApiParseError({
          message: `Failed to read OpenAPI document body: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
  );
});

/**
 * Resolve an input string to spec text — if it's a URL, fetch it via
 * HttpClient; otherwise return it as-is.
 */
export const resolveSpecText = (input: string) =>
  input.startsWith("http://") || input.startsWith("https://")
    ? fetchSpecText(input)
    : Effect.succeed(input);

/**
 * Parse an OpenAPI document from spec text and validate it's OpenAPI 3.x.
 *
 * NOTE: does NOT resolve `$ref`s. `DocResolver` + `normalizeOpenApiRefs`
 * downstream work on refs lazily, so inlining them here would just waste
 * memory — and for big specs (e.g. Cloudflare's API) that blows through
 * the 128MB Cloudflare Workers memory cap.
 */
export const parse = Effect.fn("OpenApi.parse")(function* (text: string) {
  const api = yield* Effect.try({
    try: () => parseTextToObject(text),
    catch: (error) =>
      new OpenApiParseError({
        message: `Failed to parse OpenAPI document: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

  if (!isOpenApi3(api)) {
    return yield* new OpenApiExtractionErrorFromParse({
      message:
        "Only OpenAPI 3.x documents are supported. Swagger 2.x documents should be converted first.",
    });
  }

  return api as ParsedDocument;
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const isOpenApi3 = (doc: OpenAPI.Document): doc is OpenAPIV3.Document | OpenAPIV3_1.Document =>
  "openapi" in doc && typeof doc.openapi === "string" && doc.openapi.startsWith("3.");

const parseTextToObject = (text: string): OpenAPI.Document => {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("OpenAPI document is empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = YAML.parse(trimmed);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OpenAPI document must parse to an object");
  }

  return parsed as OpenAPI.Document;
};

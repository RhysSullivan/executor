// ---------------------------------------------------------------------------
// Spec parsing + dereferencing
//
// Library choice: @readme/openapi-parser (6.x).
//   - Dual ESM/CJS package with a proper `exports` map (swagger-parser ships
//     CJS-only with no exports map, which causes friction in our bundler).
//   - Thin wrapper over @apidevtools/json-schema-ref-parser, same core that
//     swagger-parser uses — so the actual $ref / pointer logic is battle-
//     tested and shared.
//   - Circular-ref handling is object-ref-equality based (no hang, no
//     infinite recursion when walking the tree — callers just need to be
//     aware that cycles exist when traversing blindly).
//   - Pointer escape decoding (`~0` / `~1`) is handled correctly by the
//     underlying RFC 6901 pointer library, which is one of the bugs our
//     previous hand-rolled walker had.
//
// We explicitly disable:
//   - External resolvers (file + http) so the parser never reaches out —
//     essential for Cloudflare Workers where the bundled Node http polyfill
//     hangs, and for predictable Effect-based I/O (we do our own fetching
//     via HttpClient above).
//   - Schema / spec validation — we already gate on `openapi: 3.x`, and
//     the real-world specs we ingest (Cloudflare, etc.) routinely fail
//     strict validation despite being usable. Failing here would regress
//     real customer specs.
// ---------------------------------------------------------------------------

import type { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { Duration, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { dereference } from "@readme/openapi-parser";
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
 * Parse an OpenAPI document from spec text and fully dereference it.
 *
 * Steps:
 *  1. JSON.parse → YAML.parse fallback → validate we got an object.
 *  2. Assert OpenAPI 3.x (error otherwise — Swagger 2.x must be converted
 *     upstream).
 *  3. Dereference all internal `$ref`s in place via @readme/openapi-parser.
 *     Circular refs are preserved via object-identity (no hang, no infinite
 *     recursion at walk time). External refs are ignored — we don't reach
 *     out to the network from here.
 *
 * The returned document has ref-free shape for every internal pointer, so
 * downstream consumers can access `components` / `paths` without a separate
 * resolver walk. Broken pointers surface as `OpenApiParseError` — no more
 * silent partial extraction.
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

  const dereferenced = yield* Effect.tryPromise({
    try: () =>
      dereference(api as unknown as OpenAPIV3.Document, {
        resolve: { external: false },
        dereference: { circular: true },
      }) as Promise<ParsedDocument>,
    catch: (error) =>
      new OpenApiParseError({
        message: `Failed to dereference OpenAPI document: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

  return dereferenced;
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

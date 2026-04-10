import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { Effect } from "effect";

import { OpenApiParseError } from "./errors";

export type ParsedDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

/** Parse, validate, and bundle an OpenAPI document from text or URL */
export const parse = Effect.fn("OpenApi.parse")(function* (input: string) {
  const api: OpenAPI.Document = yield* Effect.tryPromise({
    try: () => {
      // If it looks like a URL, parse from URL; otherwise parse inline
      if (input.startsWith("http://") || input.startsWith("https://")) {
        return SwaggerParser.bundle(input);
      }
      // Parse from string: swagger-parser needs an object, so JSON/YAML parse first
      return SwaggerParser.bundle(parseTextToObject(input));
    },
    catch: (error) =>
      new OpenApiParseError({
        message: `Failed to parse OpenAPI document: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

  // Ensure it's OpenAPI 3.x (not Swagger 2)
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

import YAML from "yaml";
import { OpenApiExtractionError } from "./errors";

// swagger-parser's dereference needs a tagged error for this path
class OpenApiExtractionErrorFromParse extends OpenApiExtractionError {}

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

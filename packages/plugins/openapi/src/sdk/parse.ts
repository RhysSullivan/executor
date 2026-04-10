import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { Effect } from "effect";

import { OpenApiParseError } from "./errors";

export type ParsedDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

/** Parse, validate, and bundle an OpenAPI document from text or URL */
export const parse = Effect.fn("OpenApi.parse")(function* (input: string) {
  const api: OpenAPI.Document = yield* Effect.tryPromise({
    try: async () => {
      const source =
        input.startsWith("http://") || input.startsWith("https://")
          ? input
          : parseTextToObject(input);

      // Try full bundle first (resolves $refs cleanly)
      try {
        return await SwaggerParser.bundle(source);
      } catch {
        // Bundle failed (broken $refs) — parse without ref resolution,
        // then manually resolve valid refs and strip broken ones
        const parsed = (await SwaggerParser.parse(source)) as OpenAPI.Document;
        resolveRefsInPlace(parsed);
        return parsed;
      }
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

// ---------------------------------------------------------------------------
// Manual $ref resolver — resolves valid refs in-place, strips broken ones
// ---------------------------------------------------------------------------

/**
 * Walk the document tree and resolve `$ref` pointers that point to
 * `#/components/...` paths. Valid refs are inlined (deep-cloned to
 * avoid shared references). Broken refs are replaced with a
 * placeholder. Circular `$ref`s (a schema referencing itself) are
 * left as-is to avoid creating circular object graphs.
 */
const resolveRefsInPlace = (doc: OpenAPI.Document): void => {
  const lookup = (pointer: string): unknown | undefined => {
    if (!pointer.startsWith("#/")) return undefined;
    const parts = pointer.slice(2).split("/");
    let current: unknown = doc;
    for (const part of parts) {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  };

  // Track which $ref pointers are currently being resolved to detect cycles
  const resolving = new Set<string>();

  const resolveRef = (pointer: string): unknown | undefined => {
    if (resolving.has(pointer)) return undefined; // circular — leave as $ref
    const target = lookup(pointer);
    if (!target) return undefined;
    resolving.add(pointer);
    const cloned = deepClone(target);
    walk(cloned);
    resolving.delete(pointer);
    return cloned;
  };

  const deepClone = (obj: unknown): unknown => {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(deepClone);
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = deepClone(v);
    }
    return result;
  };

  const walk = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const item = obj[i];
        if (isRef(item)) {
          const resolved = resolveRef(item.$ref);
          if (resolved) obj[i] = resolved;
          else obj[i] = { description: `Unresolved: ${item.$ref}` };
        } else {
          walk(item);
        }
      }
      return;
    }

    const record = obj as Record<string, unknown>;
    for (const [k, v] of Object.entries(record)) {
      if (k === "$ref") continue;
      if (isRef(v)) {
        const resolved = resolveRef(v.$ref);
        if (resolved) record[k] = resolved;
        else record[k] = { description: `Unresolved: ${v.$ref}` };
      } else {
        walk(v);
      }
    }
  };

  walk(doc);
};

const isRef = (v: unknown): v is { $ref: string } =>
  typeof v === "object" &&
  v !== null &&
  "$ref" in v &&
  typeof (v as Record<string, unknown>).$ref === "string";

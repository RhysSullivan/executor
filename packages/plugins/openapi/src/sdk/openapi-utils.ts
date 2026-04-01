// ---------------------------------------------------------------------------
// OpenAPI type aliases and $ref resolution
//
// Wraps the openapi-types V3/V3_1 union mess and provides clean ref resolution.
// ---------------------------------------------------------------------------

import { Option } from "effect";
import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import type { ParsedDocument } from "./parse";

// ---------------------------------------------------------------------------
// Type aliases — collapse V3 / V3_1 unions into single names
// ---------------------------------------------------------------------------

export type ParameterObject = OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject;
export type OperationObject = OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject;
export type PathItemObject = OpenAPIV3.PathItemObject | OpenAPIV3_1.PathItemObject;
export type RequestBodyObject = OpenAPIV3.RequestBodyObject | OpenAPIV3_1.RequestBodyObject;
export type ResponseObject = OpenAPIV3.ResponseObject | OpenAPIV3_1.ResponseObject;
export type MediaTypeObject = OpenAPIV3.MediaTypeObject | OpenAPIV3_1.MediaTypeObject;

// ---------------------------------------------------------------------------
// DocResolver — wraps a parsed document for clean $ref resolution
// ---------------------------------------------------------------------------

export class DocResolver {
  constructor(readonly doc: ParsedDocument) {}

  /** Resolve a value that might be a $ref, returning the resolved object */
  resolve<T>(value: T | OpenAPIV3.ReferenceObject | OpenAPIV3_1.ReferenceObject): T | null {
    if (isRef(value)) {
      const resolved = this.resolvePointer(value.$ref);
      return resolved as T | null;
    }
    return value as T;
  }

  private resolvePointer(ref: string): unknown {
    if (!ref.startsWith("#/")) return null;
    const segments = ref.slice(2).split("/");
    let current: unknown = this.doc;
    for (const segment of segments) {
      if (typeof current !== "object" || current === null) return null;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }
}

const isRef = (value: unknown): value is { $ref: string } =>
  typeof value === "object" && value !== null && "$ref" in value;

// ---------------------------------------------------------------------------
// Server URL resolution
// ---------------------------------------------------------------------------

export const resolveBaseUrl = (
  servers: readonly { url: string; variables: import("effect/Option").Option<Record<string, string>> }[],
): string => {
  const server = servers[0];
  if (!server) return "";

  let url = server.url;
  if (Option.isSome(server.variables)) {
    for (const [name, value] of Object.entries(server.variables.value)) {
      url = url.replaceAll(`{${name}}`, value);
    }
  }
  return url;
};

// ---------------------------------------------------------------------------
// Content negotiation
// ---------------------------------------------------------------------------

/** Pick the preferred media type entry (prefer application/json) */
export const preferredContent = (
  content: Record<string, MediaTypeObject> | undefined,
): { mediaType: string; media: MediaTypeObject } | undefined => {
  if (!content) return undefined;
  const entries = Object.entries(content);
  const pick =
    entries.find(([mt]) => mt === "application/json") ??
    entries.find(([mt]) => mt.toLowerCase().includes("+json")) ??
    entries.find(([mt]) => mt.toLowerCase().includes("json")) ??
    entries[0];
  return pick ? { mediaType: pick[0], media: pick[1] } : undefined;
};

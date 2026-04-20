// ---------------------------------------------------------------------------
// OpenAPI type aliases and $ref resolution
//
// With parse.ts now dereferencing via @readme/openapi-parser, internal
// `$ref`s are replaced in-place with the resolved object (circular refs
// preserved via object identity). Callers rarely need to resolve manually,
// but we keep DocResolver as a thin identity layer so:
//   1. the public API surface (re-exported from sdk/index.ts) doesn't shift,
//   2. anything that still reaches `.resolve()` handles the unusual case of
//      an unresolvable external `$ref` (e.g. `http://...`) gracefully instead
//      of crashing.
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
// DocResolver — thin adapter over an already-dereferenced document
// ---------------------------------------------------------------------------

export class DocResolver {
  constructor(readonly doc: ParsedDocument) {}

  /**
   * Return `value` directly. Post-dereference, `$ref` objects only survive
   * for external references (which we deliberately don't follow); treat
   * those as unresolvable.
   */
  resolve<T>(value: T | OpenAPIV3.ReferenceObject | OpenAPIV3_1.ReferenceObject): T | null {
    if (isRef(value)) return null;
    return value as T;
  }
}

const isRef = (value: unknown): value is { $ref: string } =>
  typeof value === "object" && value !== null && "$ref" in value;

// ---------------------------------------------------------------------------
// Server URL resolution
// ---------------------------------------------------------------------------

/** Substitute `{var}` placeholders in a templated URL using a plain map. */
export const substituteUrlVariables = (
  url: string,
  values: Record<string, string>,
): string => {
  let out = url;
  for (const [name, value] of Object.entries(values)) {
    out = out.replaceAll(`{${name}}`, value);
  }
  return out;
};

type ServerLike = {
  url: string;
  variables: import("effect/Option").Option<
    Record<string, { default: string } | string>
  >;
};

export const resolveBaseUrl = (servers: readonly ServerLike[]): string => {
  const server = servers[0];
  if (!server) return "";

  if (!Option.isSome(server.variables)) return server.url;

  const values: Record<string, string> = {};
  for (const [name, v] of Object.entries(server.variables.value)) {
    values[name] = typeof v === "string" ? v : v.default;
  }
  return substituteUrlVariables(server.url, values);
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

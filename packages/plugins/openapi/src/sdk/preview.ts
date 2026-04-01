import { Effect, Option } from "effect";
import { Schema } from "effect";

import { parse } from "./parse";
import { extract } from "./extract";
import type { ExtractionResult } from "./types";

// ---------------------------------------------------------------------------
// Security scheme — what the spec declares it needs
// ---------------------------------------------------------------------------

export class SecurityScheme extends Schema.Class<SecurityScheme>("SecurityScheme")({
  /** Key name in components.securitySchemes (e.g. "api_token") */
  name: Schema.String,
  /** OpenAPI security scheme type */
  type: Schema.Literal("http", "apiKey", "oauth2", "openIdConnect"),
  /** For type: "http" — e.g. "bearer", "basic" */
  scheme: Schema.optionalWith(Schema.String, { as: "Option" }),
  /** For type: "apiKey" — where the key goes */
  in: Schema.optionalWith(Schema.Literal("header", "query", "cookie"), { as: "Option" }),
  /** For type: "apiKey" — the header/query/cookie name */
  headerName: Schema.optionalWith(Schema.String, { as: "Option" }),
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
}) {}

// ---------------------------------------------------------------------------
// Auth strategy — a valid combination of security schemes
// ---------------------------------------------------------------------------

export class AuthStrategy extends Schema.Class<AuthStrategy>("AuthStrategy")({
  /** The security schemes required together for this strategy */
  schemes: Schema.Array(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Header preset — derived from an auth strategy
// ---------------------------------------------------------------------------

export class HeaderPreset extends Schema.Class<HeaderPreset>("HeaderPreset")({
  /** Human-readable label for the UI (e.g. "Bearer Token", "API Key + Email") */
  label: Schema.String,
  /** Headers this strategy needs. Value is null when the user must provide it. */
  headers: Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.String) }),
  /** Which headers should be stored as secrets */
  secretHeaders: Schema.Array(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Spec preview — everything the frontend needs
// ---------------------------------------------------------------------------

export class SpecPreview extends Schema.Class<SpecPreview>("SpecPreview")({
  title: Schema.optionalWith(Schema.String, { as: "Option" }),
  version: Schema.optionalWith(Schema.String, { as: "Option" }),
  /** Reuses ServerInfo from extraction */
  servers: Schema.Array(Schema.Unknown),
  operationCount: Schema.Number,
  tags: Schema.Array(Schema.String),
  securitySchemes: Schema.Array(SecurityScheme),
  /** Valid auth strategies (each is a set of schemes used together) */
  authStrategies: Schema.Array(AuthStrategy),
  /** Pre-built header presets derived from auth strategies */
  headerPresets: Schema.Array(HeaderPreset),
}) {}

// ---------------------------------------------------------------------------
// Security scheme extraction
// ---------------------------------------------------------------------------

const extractSecuritySchemes = (
  rawSchemes: Record<string, unknown>,
): SecurityScheme[] =>
  Object.entries(rawSchemes).flatMap(([name, schemeOrRef]) => {
    if (!schemeOrRef || typeof schemeOrRef !== "object") return [];
    const scheme = schemeOrRef as Record<string, unknown>;
    if ("$ref" in scheme) return [];

    const type = scheme.type as string;
    if (!["http", "apiKey", "oauth2", "openIdConnect"].includes(type)) return [];

    return [
      new SecurityScheme({
        name,
        type: type as "http" | "apiKey" | "oauth2" | "openIdConnect",
        scheme: Option.fromNullable(scheme.scheme as string | undefined),
        in: Option.fromNullable(
          scheme.in as "header" | "query" | "cookie" | undefined,
        ),
        headerName: Option.fromNullable(scheme.name as string | undefined),
        description: Option.fromNullable(scheme.description as string | undefined),
      }),
    ];
  });

// ---------------------------------------------------------------------------
// Header preset builder
// ---------------------------------------------------------------------------

const buildHeaderPresets = (
  schemes: readonly SecurityScheme[],
  strategies: readonly AuthStrategy[],
): HeaderPreset[] => {
  const schemeMap = new Map(schemes.map((s) => [s.name, s]));

  return strategies.flatMap((strategy) => {
    const resolved = strategy.schemes
      .map((name) => schemeMap.get(name))
      .filter((s): s is SecurityScheme => s !== undefined);

    if (resolved.length === 0) return [];

    const headers: Record<string, string | null> = {};
    const secretHeaders: string[] = [];
    const labelParts: string[] = [];

    for (const scheme of resolved) {
      if (scheme.type === "http" && Option.getOrElse(scheme.scheme, () => "") === "bearer") {
        headers["Authorization"] = null;
        secretHeaders.push("Authorization");
        labelParts.push("Bearer Token");
      } else if (scheme.type === "http" && Option.getOrElse(scheme.scheme, () => "") === "basic") {
        headers["Authorization"] = null;
        secretHeaders.push("Authorization");
        labelParts.push("Basic Auth");
      } else if (scheme.type === "apiKey" && Option.getOrElse(scheme.in, () => "") === "header") {
        const headerName = Option.getOrElse(scheme.headerName, () => scheme.name);
        headers[headerName] = null;
        secretHeaders.push(headerName);
        labelParts.push(scheme.name);
      } else if (scheme.type === "apiKey") {
        labelParts.push(`${scheme.name} (${Option.getOrElse(scheme.in, () => "unknown")})`);
      } else {
        labelParts.push(scheme.name);
      }
    }

    if (Object.keys(headers).length === 0 && resolved.length > 0) {
      return [
        new HeaderPreset({ label: labelParts.join(" + "), headers: {}, secretHeaders: [] }),
      ];
    }

    return [
      new HeaderPreset({ label: labelParts.join(" + "), headers, secretHeaders }),
    ];
  });
};

// ---------------------------------------------------------------------------
// Collect unique tags from extraction result
// ---------------------------------------------------------------------------

const collectTags = (result: ExtractionResult): string[] => {
  const tagSet = new Set<string>();
  for (const op of result.operations) {
    for (const tag of op.tags) tagSet.add(tag);
  }
  return [...tagSet].sort();
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Preview an OpenAPI spec — extract metadata without registering anything.
 *  Reuses parse() + extract() for the heavy lifting. */
export const previewSpec = Effect.fn("OpenApi.previewSpec")(function* (
  specText: string,
) {
  const doc = yield* parse(specText);
  const result = yield* extract(doc);

  const securitySchemes = extractSecuritySchemes(
    doc.components?.securitySchemes ?? {},
  );

  const rawSecurity = (doc.security ?? []) as Array<Record<string, unknown>>;
  const authStrategies = rawSecurity.map(
    (entry) => new AuthStrategy({ schemes: Object.keys(entry) }),
  );

  return new SpecPreview({
    title: result.title,
    version: result.version,
    servers: result.servers as unknown as readonly unknown[],
    operationCount: result.operations.length,
    tags: collectTags(result),
    securitySchemes,
    authStrategies,
    headerPresets: buildHeaderPresets(securitySchemes, authStrategies),
  });
});

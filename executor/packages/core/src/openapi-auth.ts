import type { OpenApiAuth } from "./tool/source-types";
import { z } from "zod";
import { toPlainObject } from "./utils";

function toRecordOrEmpty(value: unknown): Record<string, unknown> {
  return toPlainObject(value) ?? {};
}

const securityRequirementSchema = z.record(z.array(z.unknown()).optional());

const securitySchemeSchema = z.object({
  type: z.string().optional(),
  scheme: z.string().optional(),
  in: z.string().optional(),
  name: z.string().optional(),
});

export function inferOpenApiAuth(spec: Record<string, unknown>): OpenApiAuth | undefined {
  const components = toRecordOrEmpty(spec.components);
  const securitySchemes = toRecordOrEmpty(components.securitySchemes);
  if (Object.keys(securitySchemes).length === 0) {
    return undefined;
  }

  const security = Array.isArray(spec.security)
    ? spec.security
      .map((entry) => securityRequirementSchema.safeParse(entry))
      .filter((entry): entry is { success: true; data: Record<string, unknown[]> } => entry.success)
      .map((entry) => entry.data)
    : [];

  const securitySchemeNames = new Set(Object.keys(securitySchemes));

  const referencedSchemeName = security
    .flatMap((entry) => Object.keys(entry))
    .find((name) => securitySchemeNames.has(name));

  const schemeName = referencedSchemeName ?? Object.keys(securitySchemes)[0];
  if (!schemeName) return undefined;

  const parsedScheme = securitySchemeSchema.safeParse(securitySchemes[schemeName]);
  if (!parsedScheme.success) {
    return undefined;
  }

  const scheme = parsedScheme.data;
  const type = (scheme.type ?? "").toLowerCase();

  if (type === "http") {
    const httpScheme = (scheme.scheme ?? "").toLowerCase();
    if (httpScheme === "bearer") {
      return { type: "bearer", mode: "workspace" };
    }
    if (httpScheme === "basic") {
      return { type: "basic", mode: "workspace" };
    }
    return undefined;
  }

  if (type === "apikey") {
    const location = (scheme.in ?? "").toLowerCase();
    const header = (scheme.name ?? "").trim();
    if (location === "header" && header.length > 0) {
      return { type: "apiKey", mode: "workspace", header };
    }
    return undefined;
  }

  if (type === "oauth2" || type === "openidconnect") {
    return { type: "bearer", mode: "workspace" };
  }

  return undefined;
}

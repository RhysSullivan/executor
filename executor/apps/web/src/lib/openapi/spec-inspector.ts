import { Result } from "better-result";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CredentialScope, SourceAuthType } from "@/lib/types";

type SupportedAuthType = Exclude<SourceAuthType, "none" | "mixed">;

export type InferredSpecAuth = {
  type: SourceAuthType;
  mode?: CredentialScope;
  header?: string;
  inferred: true;
};

type OpenApiInspectionResult = {
  spec: Record<string, unknown>;
  inferredAuth: InferredSpecAuth;
};

const recordSchema = z.record(z.string(), z.unknown());

const securityRequirementSchema = z.record(z.string(), z.array(z.unknown()).optional());

const securitySchemeSchema = z.object({
  type: z.string().optional(),
  scheme: z.string().optional(),
  in: z.string().optional(),
  name: z.string().optional(),
});

function toRecordValue(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function parseObjectFromText(text: string, format: "json" | "yaml"): Record<string, unknown> | null {
  const parsed = format === "json"
    ? Result.try(() => JSON.parse(text))
    : Result.try(() => parseYaml(text));
  if (parsed.isErr()) {
    return null;
  }

  const parsedRecord = recordSchema.safeParse(parsed.value);
  if (!parsedRecord.success || Object.keys(parsedRecord.data).length === 0) {
    return null;
  }

  return parsedRecord.data;
}

function parseOpenApiPayload(raw: string, sourceUrl: string, contentType: string): Record<string, unknown> {
  const loweredContentType = contentType.toLowerCase();
  const loweredUrl = sourceUrl.toLowerCase();
  const preferJson = loweredContentType.includes("json") || loweredUrl.endsWith(".json");

  const primary = preferJson
    ? parseObjectFromText(raw, "json")
    : parseObjectFromText(raw, "yaml");
  const fallback = preferJson
    ? parseObjectFromText(raw, "yaml")
    : parseObjectFromText(raw, "json");
  const parsed = primary ?? fallback;

  if (!parsed) {
    throw new Error("Spec payload is empty or not an object");
  }

  return parsed;
}

function normalizeAuthScheme(scheme: unknown): {
  type: SupportedAuthType;
  header?: string;
} | null {
  const parsedScheme = securitySchemeSchema.safeParse(scheme);
  if (!parsedScheme.success) {
    return null;
  }

  const type = (parsedScheme.data.type ?? "").toLowerCase();

  if (type === "http") {
    const httpScheme = (parsedScheme.data.scheme ?? "").toLowerCase();
    if (httpScheme === "bearer") {
      return { type: "bearer" };
    }
    if (httpScheme === "basic") {
      return { type: "basic" };
    }
    return null;
  }

  if (type === "apikey") {
    const location = (parsedScheme.data.in ?? "").toLowerCase();
    const header = (parsedScheme.data.name ?? "").trim();
    if (location === "header" && header.length > 0) {
      return { type: "apiKey", header };
    }
    return null;
  }

  if (type === "oauth2" || type === "openidconnect") {
    return { type: "bearer" };
  }

  return null;
}

function inferSecuritySchemaAuth(spec: Record<string, unknown>): InferredSpecAuth {
  const components = toRecordValue(spec.components);
  const securitySchemes = toRecordValue(components.securitySchemes);
  const schemeNames = Object.keys(securitySchemes);
  if (schemeNames.length === 0) {
    return { type: "none", inferred: true };
  }

  const globalSecurity = Array.isArray(spec.security)
    ? spec.security.flatMap((entry) => {
      const parsed = securityRequirementSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    })
    : [];
  const referencedSchemeNames = globalSecurity.flatMap((entry) => Object.keys(entry));
  const candidateNames = referencedSchemeNames.length > 0
    ? [...new Set(referencedSchemeNames.filter((name) => Object.prototype.hasOwnProperty.call(securitySchemes, name)))]
    : schemeNames;

  const normalized = candidateNames
    .map((name) => normalizeAuthScheme(securitySchemes[name]))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  if (normalized.length === 0) {
    return { type: "none", inferred: true };
  }

  const deduped = new Map<string, { type: SupportedAuthType; header?: string }>();
  for (const entry of normalized) {
    const key = entry.type === "apiKey" ? `${entry.type}:${entry.header ?? ""}` : entry.type;
    if (!deduped.has(key)) {
      deduped.set(key, entry);
    }
  }

  if (deduped.size > 1) {
    return { type: "mixed", inferred: true };
  }

  const selected = [...deduped.values()][0];
  return {
    type: selected.type,
    mode: "workspace",
    ...(selected.type === "apiKey" && selected.header ? { header: selected.header } : {}),
    inferred: true,
  };
}

export async function fetchAndInspectOpenApiSpec(input: {
  specUrl: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<OpenApiInspectionResult> {
  const response = await fetch(input.specUrl, {
    method: "GET",
    headers: {
      Accept: "application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.8",
      ...(input.headers ?? {}),
    },
    signal: input.signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch spec (${response.status} ${response.statusText})`);
  }

  const raw = await response.text();
  if (!raw.trim()) {
    throw new Error("Spec response was empty");
  }

  const contentType = response.headers.get("content-type") ?? "";
  const spec = parseOpenApiPayload(raw, input.specUrl, contentType);
  const inferredAuth = inferSecuritySchemaAuth(spec);
  return { spec, inferredAuth };
}

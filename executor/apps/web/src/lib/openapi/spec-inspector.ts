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

const inferredSpecAuthSchema = z.object({
  type: z.enum(["none", "bearer", "apiKey", "basic", "mixed"]),
  mode: z.enum(["workspace", "account", "organization"]).optional(),
  header: z.string().optional(),
  inferred: z.literal(true),
});

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

function formatStatus(status?: number, statusText?: string): string {
  if (typeof status !== "number" || status <= 0) {
    return "request failed";
  }
  const normalizedStatusText = typeof statusText === "string" ? statusText.trim() : "";
  return normalizedStatusText ? `${status} ${normalizedStatusText}` : String(status);
}

export function createSpecFetchErrorMessage(input: {
  status?: number;
  statusText?: string;
  detail?: string;
}): string {
  const statusLabel = formatStatus(input.status, input.statusText);
  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  if (!detail) {
    return `Failed to fetch spec (${statusLabel})`;
  }
  return `Failed to fetch spec (${statusLabel}): ${detail}`;
}

export function inspectOpenApiPayload(input: {
  raw: string;
  sourceUrl: string;
  contentType?: string;
}): OpenApiInspectionResult {
  if (!input.raw.trim()) {
    throw new Error("Spec response was empty");
  }

  const spec = parseOpenApiPayload(input.raw, input.sourceUrl, input.contentType ?? "");
  const inferredAuth = inferSecuritySchemaAuth(spec);
  return { spec, inferredAuth };
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
  const response = await fetch("/api/openapi/inspect", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      specUrl: input.specUrl,
      headers: input.headers ?? {},
    }),
    signal: input.signal,
    cache: "no-store",
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const payloadRecord = recordSchema.safeParse(payload);
    const detail = payloadRecord.success && typeof payloadRecord.data.detail === "string"
      ? payloadRecord.data.detail
      : "";
    const status = payloadRecord.success && typeof payloadRecord.data.status === "number"
      ? payloadRecord.data.status
      : response.status;
    const statusText = payloadRecord.success && typeof payloadRecord.data.statusText === "string"
      ? payloadRecord.data.statusText
      : response.statusText;
    throw new Error(createSpecFetchErrorMessage({ status, statusText, detail }));
  }

  const payloadRecord = recordSchema.safeParse(payload);
  if (!payloadRecord.success) {
    throw new Error("Spec inspection returned an invalid response");
  }

  const parsedSpec = recordSchema.safeParse(payloadRecord.data.spec);
  if (!parsedSpec.success) {
    throw new Error("Spec inspection did not return a valid OpenAPI document");
  }

  const parsedAuth = inferredSpecAuthSchema.safeParse(payloadRecord.data.inferredAuth);
  const inferredAuth = parsedAuth.success ? parsedAuth.data : inferSecuritySchemaAuth(parsedSpec.data);

  return { spec: parsedSpec.data, inferredAuth };
}

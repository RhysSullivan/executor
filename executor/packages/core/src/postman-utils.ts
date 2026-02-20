import { z } from "zod";

const POSTMAN_TEMPLATE_PATTERN = /\{\{([^{}]+)\}\}/g;
const recordSchema = z.record(z.unknown());

function coerceRecord(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function interpolatePostmanTemplate(value: string, variables: Record<string, string>): string {
  return value.replace(POSTMAN_TEMPLATE_PATTERN, (_, rawKey: string) => {
    const key = rawKey.trim();
    const resolved = variables[key];
    return resolved !== undefined ? resolved : `{{${key}}}`;
  });
}

export function findUnresolvedPostmanTemplateKeys(value: string): string[] {
  const unresolved = new Set<string>();
  for (const match of value.matchAll(POSTMAN_TEMPLATE_PATTERN)) {
    const key = match[1]?.trim();
    if (key) unresolved.add(key);
  }
  return [...unresolved];
}

export function asStringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(coerceRecord(value))) {
    result[key] = stringifyTemplateValue(entry);
  }
  return result;
}

export function detectJsonContentType(headers: Record<string, string>): boolean {
  return Object.entries(headers)
    .some(([name, value]) => name.toLowerCase() === "content-type" && /json/i.test(value));
}

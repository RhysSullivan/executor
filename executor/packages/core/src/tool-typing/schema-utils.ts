import type { JsonSchema } from "../types";
import { asRecord } from "../utils";

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

function collectTopLevelRequiredKeys(schema: JsonSchema, out: string[]): void {
  const required = Array.isArray((schema as Record<string, unknown>).required)
    ? ((schema as Record<string, unknown>).required as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  out.push(...required);

  const allOf = Array.isArray((schema as Record<string, unknown>).allOf)
    ? ((schema as Record<string, unknown>).allOf as unknown[])
    : [];
  for (const entry of allOf) {
    if (!entry || typeof entry !== "object") continue;
    collectTopLevelRequiredKeys(entry as JsonSchema, out);
  }
}

function collectTopLevelPropertyKeys(schema: JsonSchema, out: string[]): void {
  const props = asRecord((schema as Record<string, unknown>).properties);
  out.push(...Object.keys(props));

  const allOf = Array.isArray((schema as Record<string, unknown>).allOf)
    ? ((schema as Record<string, unknown>).allOf as unknown[])
    : [];
  for (const entry of allOf) {
    if (!entry || typeof entry !== "object") continue;
    collectTopLevelPropertyKeys(entry as JsonSchema, out);
  }
}

export function extractTopLevelRequiredKeys(schema?: JsonSchema): string[] {
  if (!schema || typeof schema !== "object") return [];
  const required: string[] = [];
  collectTopLevelRequiredKeys(schema, required);
  return uniq(required);
}

export function extractTopLevelPropertyKeys(schema?: JsonSchema): string[] {
  if (!schema || typeof schema !== "object") return [];
  const keys: string[] = [];
  collectTopLevelPropertyKeys(schema, keys);
  return uniq(keys);
}

export function buildPreviewKeys(schema?: JsonSchema): string[] {
  const required = extractTopLevelRequiredKeys(schema);
  const props = extractTopLevelPropertyKeys(schema);
  const remaining = props.filter((k) => !required.includes(k));
  return [...required, ...remaining];
}

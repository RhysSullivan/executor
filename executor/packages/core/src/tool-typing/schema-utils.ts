import type { JsonSchema } from "../types";
import { asRecord } from "../utils";

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function collectTopLevelRequiredKeys(schema: Record<string, unknown>, out: string[]): void {
  const required = asUnknownArray(schema.required)
    .filter((value): value is string => typeof value === "string");
  out.push(...required);

  const allOf = asUnknownArray(schema.allOf);
  for (const entry of allOf) {
    const nested = asRecord(entry);
    if (Object.keys(nested).length === 0) continue;
    collectTopLevelRequiredKeys(nested, out);
  }
}

function collectTopLevelPropertyKeys(schema: Record<string, unknown>, out: string[]): void {
  const props = asRecord(schema.properties);
  out.push(...Object.keys(props));

  const allOf = asUnknownArray(schema.allOf);
  for (const entry of allOf) {
    const nested = asRecord(entry);
    if (Object.keys(nested).length === 0) continue;
    collectTopLevelPropertyKeys(nested, out);
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

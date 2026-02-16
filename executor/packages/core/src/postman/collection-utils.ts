import { sanitizeSegment, sanitizeSnakeSegment } from "../tool/path-utils";
import { stringifyTemplateValue } from "../postman-utils";
import { asRecord } from "../utils";

export type PostmanRequestBody =
  | { kind: "urlencoded"; entries: Array<{ key: string; value: string }> }
  | { kind: "raw"; text: string };

export function buildPostmanToolPath(
  sourceName: string,
  requestName: string,
  folderPath: string[],
  usedPaths: Set<string>,
): string {
  const source = sanitizeSegment(sourceName);
  const segments = [
    source,
    ...folderPath.map((segment) => sanitizeSegment(segment)).filter((segment) => segment.length > 0),
    sanitizeSnakeSegment(requestName),
  ];
  const basePath = segments.join(".");

  let path = basePath;
  let suffix = 2;
  while (usedPaths.has(path)) {
    path = `${basePath}_${suffix}`;
    suffix += 1;
  }
  usedPaths.add(path);
  return path;
}

export function resolvePostmanFolderPath(
  folderId: string | undefined,
  folderById: Map<string, { name: string; parentId?: string }>,
): string[] {
  const path: string[] = [];
  let cursor = folderId;
  let safety = 0;
  while (cursor && safety < 100) {
    safety += 1;
    const folder = folderById.get(cursor);
    if (!folder) break;
    path.unshift(folder.name);
    cursor = folder.parentId;
  }
  return path;
}

export function extractPostmanVariableMap(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const entry of value) {
    const record = asRecord(entry);
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key) continue;
    if (record.disabled === true) continue;
    result[key] = stringifyTemplateValue(record.value);
  }
  return result;
}

export function extractPostmanHeaderMap(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const entry of value) {
    const record = asRecord(entry);
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key || record.disabled === true) continue;
    result[key] = stringifyTemplateValue(record.value);
  }
  return result;
}

export function extractPostmanQueryEntries(value: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(value)) return [];
  const entries: Array<{ key: string; value: string }> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key || record.disabled === true) continue;
    entries.push({ key, value: stringifyTemplateValue(record.value) });
  }
  return entries;
}

export function extractPostmanBody(record: Record<string, unknown>): PostmanRequestBody | undefined {
  const dataMode = typeof record.dataMode === "string" ? record.dataMode.toLowerCase() : "";
  if (dataMode === "urlencoded" && Array.isArray(record.data)) {
    const entries: Array<{ key: string; value: string }> = [];
    for (const item of record.data) {
      const entry = asRecord(item);
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      if (!key || entry.disabled === true) continue;
      entries.push({ key, value: stringifyTemplateValue(entry.value) });
    }
    return entries.length > 0 ? { kind: "urlencoded", entries } : undefined;
  }

  if (typeof record.rawModeData === "string" && record.rawModeData.length > 0) {
    return { kind: "raw", text: record.rawModeData };
  }

  return undefined;
}

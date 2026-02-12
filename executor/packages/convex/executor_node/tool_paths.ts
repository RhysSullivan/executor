"use node";

import type { ToolDefinition } from "../../core/src/types";

function normalizeToolPathSegment(segment: string): string {
  return segment.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeToolPath(path: string): string {
  return path
    .split(".")
    .filter(Boolean)
    .map((segment) => normalizeToolPathSegment(segment))
    .join(".");
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length] ?? Math.max(a.length, b.length);
}

export function resolveAliasedToolPath(
  requestedPath: string,
  toolMap: Map<string, ToolDefinition>,
): string | null {
  if (toolMap.has(requestedPath)) return requestedPath;

  const normalizedRequested = normalizeToolPath(requestedPath);
  if (!normalizedRequested) return null;

  const matches: string[] = [];
  for (const path of toolMap.keys()) {
    if (normalizeToolPath(path) === normalizedRequested) {
      matches.push(path);
    }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;

  const requestedSegments = requestedPath.split(".").length;
  const sameSegmentCount = matches.filter((path) => path.split(".").length === requestedSegments);
  const pool = sameSegmentCount.length > 0 ? sameSegmentCount : matches;
  return [...pool].sort((a, b) => a.length - b.length || a.localeCompare(b))[0] ?? null;
}

export function suggestToolPaths(
  requestedPath: string,
  toolMap: Map<string, ToolDefinition>,
  limit = 3,
): string[] {
  const normalizedRequested = normalizeToolPath(requestedPath);
  const requestedSegments = normalizedRequested.split(".").filter(Boolean);
  const requestedNamespace = requestedSegments[0] ?? "";

  return [...toolMap.keys()]
    .map((path) => {
      const normalizedCandidate = normalizeToolPath(path);
      const candidateSegments = normalizedCandidate.split(".").filter(Boolean);
      const candidateNamespace = candidateSegments[0] ?? "";

      let score = -levenshteinDistance(normalizedRequested, normalizedCandidate);

      if (requestedNamespace && requestedNamespace === candidateNamespace) {
        score += 6;
      }

      if (normalizedCandidate.includes(normalizedRequested) || normalizedRequested.includes(normalizedCandidate)) {
        score += 3;
      }

      const sharedPrefix = Math.min(requestedSegments.length, candidateSegments.length);
      let prefixMatches = 0;
      for (let i = 0; i < sharedPrefix; i++) {
        if (requestedSegments[i] !== candidateSegments[i]) break;
        prefixMatches += 1;
      }
      score += prefixMatches * 2;

      return { path, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.path);
}

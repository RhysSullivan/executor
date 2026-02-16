"use node";

import type { ToolDefinition } from "../../../core/src/types";

const GENERIC_NAMESPACE_SUFFIXES = new Set([
  "api",
  "apis",
  "openapi",
  "sdk",
  "service",
  "services",
]);

function tokenizePathSegment(segment: string): string[] {
  const normalized = segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

  return normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function normalizeToolPathSegment(segment: string, isNamespace = false): string {
  const tokens = tokenizePathSegment(segment);
  if (tokens.length === 0) {
    return segment.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  const collapsed: string[] = [];
  for (const token of tokens) {
    if (collapsed[collapsed.length - 1] === token) continue;
    collapsed.push(token);
  }

  if (isNamespace) {
    while (collapsed.length > 1) {
      const last = collapsed[collapsed.length - 1];
      if (!last || !GENERIC_NAMESPACE_SUFFIXES.has(last)) break;
      collapsed.pop();
    }
  }

  return collapsed.join("");
}

export function normalizeToolPathForLookup(path: string): string {
  const segments = path
    .split(".")
    .filter(Boolean);

  return segments
    .map((segment, index) => normalizeToolPathSegment(segment, index === 0))
    .join(".");
}

export function toPreferredToolPath(path: string): string {
  const segments = path
    .split(".")
    .filter(Boolean);
  if (segments.length === 0) return path;

  const namespaceTokens = tokenizePathSegment(segments[0]!);
  const collapsedNamespace: string[] = [];
  for (const token of namespaceTokens) {
    if (collapsedNamespace[collapsedNamespace.length - 1] === token) continue;
    collapsedNamespace.push(token);
  }
  while (collapsedNamespace.length > 1) {
    const last = collapsedNamespace[collapsedNamespace.length - 1];
    if (!last || !GENERIC_NAMESPACE_SUFFIXES.has(last)) break;
    collapsedNamespace.pop();
  }

  const namespace = collapsedNamespace.join("_");
  if (!namespace || namespace === segments[0]) return path;
  return [namespace, ...segments.slice(1)].join(".");
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

  const normalizedRequested = normalizeToolPathForLookup(requestedPath);
  if (!normalizedRequested) return null;

  const matches: string[] = [];
  for (const path of toolMap.keys()) {
    if (normalizeToolPathForLookup(path) === normalizedRequested) {
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
  const normalizedRequested = normalizeToolPathForLookup(requestedPath);
  const requestedSegments = normalizedRequested.split(".").filter(Boolean);
  const requestedNamespace = requestedSegments[0] ?? "";

  return [...toolMap.keys()]
    .map((path) => {
      const normalizedCandidate = normalizeToolPathForLookup(path);
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

export function resolveClosestToolPath(
  requestedPath: string,
  toolMap: Map<string, ToolDefinition>,
): string | null {
  const normalizedRequested = normalizeToolPathForLookup(requestedPath);
  if (!normalizedRequested) return null;

  const requestedNamespace = normalizedRequested.split(".").filter(Boolean)[0] ?? "";
  const requestedLength = normalizedRequested.length;
  const maxDistance = Math.max(2, Math.floor(requestedLength * 0.2));

  const ranked = [...toolMap.keys()]
    .map((path) => {
      const normalizedCandidate = normalizeToolPathForLookup(path);
      const candidateNamespace = normalizedCandidate.split(".").filter(Boolean)[0] ?? "";
      const distance = levenshteinDistance(normalizedRequested, normalizedCandidate);
      let score = -distance;

      if (requestedNamespace && requestedNamespace === candidateNamespace) {
        score += 8;
      }

      if (normalizedCandidate.includes(normalizedRequested) || normalizedRequested.includes(normalizedCandidate)) {
        score += 4;
      }

      return {
        path,
        score,
        distance,
        candidateNamespace,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;
  if (best.distance > maxDistance) return null;
  if (requestedNamespace && best.candidateNamespace !== requestedNamespace && best.distance > 1) return null;

  const second = ranked[1];
  if (second && best.score - second.score < 3) {
    return null;
  }

  return best.path;
}

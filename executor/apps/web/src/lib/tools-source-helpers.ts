import { parse as parseDomain } from "tldts";
import type {
  CredentialRecord,
  OpenApiSourceQuality,
  SourceAuthProfile,
  ToolSourceRecord,
} from "@/lib/types";

export type SourceAuthType = "none" | "bearer" | "apiKey" | "basic" | "mixed";
export type SourceAuthMode = "workspace" | "actor";

const RAW_HOSTS = new Set([
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "raw.github.com",
]);

function faviconForUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch {
    return null;
  }
}

export function getSourceFavicon(source: ToolSourceRecord): string | null {
  if (source.type === "mcp") {
    return faviconForUrl((source.config.url as string) ?? null);
  }
  if (source.type === "graphql") {
    return faviconForUrl((source.config.endpoint as string) ?? null);
  }
  const spec = source.config.spec as string | undefined;
  const specUrl = source.config.specUrl as string | undefined;
  if (typeof spec === "string" && spec.startsWith("postman:")) {
    return null;
  }
  const baseUrl = source.config.baseUrl as string | undefined;
  const collectionUrl = source.config.collectionUrl as string | undefined;
  const resolvedSpecUrl = typeof specUrl === "string" && specUrl.startsWith("http")
    ? specUrl
    : typeof spec === "string" && spec.startsWith("http")
      ? spec
      : null;
  return faviconForUrl(baseUrl ?? collectionUrl ?? resolvedSpecUrl);
}

export function sourceEndpointLabel(source: ToolSourceRecord): string {
  if (source.type === "mcp") return (source.config.url as string) ?? "";
  if (source.type === "graphql") return (source.config.endpoint as string) ?? "";

  const spec = source.config.spec;
  const specUrl = source.config.specUrl;
  if (typeof spec === "string" && spec.startsWith("postman:")) {
    const uid = spec.slice("postman:".length).trim();
    if (uid.length > 0) {
      return `catalog:${uid}`;
    }
    return "catalog:collection";
  }

  if (typeof specUrl === "string" && specUrl.length > 0) {
    return specUrl;
  }

  return (source.config.spec as string) ?? "";
}

export function sourceKeyForSource(source: ToolSourceRecord): string | null {
  if (source.type === "openapi") return `source:${source.id}`;
  if (source.type === "graphql") return `source:${source.id}`;
  if (source.type === "mcp") return `source:${source.id}`;
  return null;
}

export function toolSourceLabelForSource(source: ToolSourceRecord): string {
  return `${source.type}:${source.name}`;
}

export function sourceForCredentialKey(sources: ToolSourceRecord[], sourceKey: string): ToolSourceRecord | null {
  const prefix = "source:";
  if (!sourceKey.startsWith(prefix)) return null;
  const sourceId = sourceKey.slice(prefix.length);
  if (!sourceId) return null;
  return sources.find((source) => source.id === sourceId) ?? null;
}

export function sourceAuthProfileForSource(
  source: ToolSourceRecord,
  sourceAuthProfiles: Record<string, SourceAuthProfile>,
): SourceAuthProfile | undefined {
  const sourceKey = sourceKeyForSource(source);
  if (sourceKey && sourceAuthProfiles[sourceKey]) {
    return sourceAuthProfiles[sourceKey];
  }

  const legacyKey = toolSourceLabelForSource(source);
  if (sourceAuthProfiles[legacyKey]) {
    return sourceAuthProfiles[legacyKey];
  }

  return undefined;
}

function normalizeSourceAuthProfile(profile: SourceAuthProfile | undefined): {
  type: SourceAuthType;
  mode?: SourceAuthMode;
  header?: string;
  inferred?: boolean;
} {
  if (!profile) {
    return { type: "none" };
  }

  const type = profile.type === "mixed"
    ? "mixed"
    : profile.type === "basic"
      ? "basic"
      : profile.type === "apiKey"
        ? "apiKey"
        : profile.type === "bearer"
          ? "bearer"
          : "none";

  const mode = profile.mode === "actor" ? "actor" : profile.mode === "workspace" ? "workspace" : undefined;
  const header = typeof profile.header === "string" && profile.header.trim().length > 0
    ? profile.header.trim()
    : undefined;

  return {
    type,
    ...(mode ? { mode } : {}),
    ...(header ? { header } : {}),
    inferred: Boolean(profile.inferred),
  };
}

export function readSourceAuth(
  source: ToolSourceRecord,
  inferredProfile?: SourceAuthProfile,
): {
  type: SourceAuthType;
  mode?: SourceAuthMode;
  header?: string;
  inferred?: boolean;
} {
  if (source.type !== "openapi" && source.type !== "graphql" && source.type !== "mcp") {
    return { type: "none" };
  }

  const inferred = normalizeSourceAuthProfile(inferredProfile);

  const auth = source.config.auth as Record<string, unknown> | undefined;
  const type =
    auth && typeof auth.type === "string" && ["none", "bearer", "apiKey", "basic", "mixed"].includes(auth.type)
      ? (auth.type as SourceAuthType)
      : inferred.type;

  const mode =
    auth && typeof auth.mode === "string" && (auth.mode === "workspace" || auth.mode === "actor")
      ? (auth.mode as SourceAuthMode)
      : inferred.mode;

  const header = auth && typeof auth.header === "string" && auth.header.trim().length > 0
    ? auth.header.trim()
    : inferred.header;

  return {
    type,
    ...(mode ? { mode } : {}),
    ...(header ? { header } : {}),
    inferred: auth?.type === undefined ? inferred.inferred : false,
  };
}

export function formatSourceAuthBadge(source: ToolSourceRecord, inferredProfile?: SourceAuthProfile): string | null {
  const auth = readSourceAuth(source, inferredProfile);
  if (auth.type === "none") return null;
  if (auth.type === "mixed") return "Mixed auth";
  const mode = auth.mode ?? "workspace";
  const authLabel =
    auth.type === "apiKey"
      ? "API Key"
      : auth.type === "bearer"
        ? "Bearer"
        : auth.type === "basic"
          ? "Basic"
          : "Auth";
  return `${authLabel} · ${mode === "actor" ? "user" : "workspace"}`;
}

export function credentialStatsForSource(source: ToolSourceRecord, credentials: CredentialRecord[]): {
  workspaceCount: number;
  actorCount: number;
} {
  const sourceKey = sourceKeyForSource(source);
  if (!sourceKey) {
    return { workspaceCount: 0, actorCount: 0 };
  }

  let workspaceCount = 0;
  let actorCount = 0;
  for (const credential of credentials) {
    if (credential.sourceKey !== sourceKey) continue;
    if (credential.scope === "workspace") workspaceCount += 1;
    if (credential.scope === "actor") actorCount += 1;
  }

  return { workspaceCount, actorCount };
}

export function formatQualityPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function qualityToneClass(quality: OpenApiSourceQuality): string {
  if (quality.overallQuality >= 0.95) {
    return "text-terminal-green";
  }
  if (quality.overallQuality >= 0.85) {
    return "text-terminal-amber";
  }
  return "text-terminal-red";
}

export function qualitySummaryLabel(quality: OpenApiSourceQuality): string {
  if (quality.overallQuality >= 0.95) {
    return "strong typing";
  }
  if (quality.overallQuality >= 0.85) {
    return "mostly typed";
  }
  return "needs type cleanup";
}

export function compactEndpointLabel(source: ToolSourceRecord): string {
  const endpoint = sourceEndpointLabel(source);
  if (endpoint.startsWith("catalog:")) return endpoint;
  try {
    const parsed = new URL(endpoint);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return endpoint;
  }
}

export function inferNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parsed = parseDomain(url);

    if (RAW_HOSTS.has(u.hostname)) {
      const segments = u.pathname.split("/").filter(Boolean);
      if (segments.length > 0) return segments[0].toLowerCase();
    }

    if (parsed.domainWithoutSuffix) {
      return parsed.domainWithoutSuffix;
    }

    if (parsed.domain) {
      return parsed.domain.split(".")[0];
    }

    return u.hostname.replace(/\./g, "-");
  } catch {
    return "";
  }
}

function sanitizeSourceName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "source";
}

export function withUniqueSourceName(baseName: string, takenNames: Set<string>): string {
  const loweredTaken = new Set([...takenNames].map((name) => name.toLowerCase()));
  const candidate = sanitizeSourceName(baseName);
  if (!loweredTaken.has(candidate.toLowerCase())) {
    return candidate;
  }

  let suffix = 2;
  while (true) {
    const next = `${candidate}-${suffix}`;
    if (!loweredTaken.has(next.toLowerCase())) {
      return next;
    }
    suffix += 1;
  }
}

function sourceNameFromCatalogId(id: string): string {
  let slug = sanitizeSourceName(id);
  slug = slug
    .replace(/-openapi$/, "")
    .replace(/-graphql-api$/, "")
    .replace(/-rest-api$/, "")
    .replace(/-api$/, "")
    .replace(/-rest$/, "");
  return slug || "catalog";
}

export function catalogSourceName(item: { id?: string; providerName: string; name: string }): string {
  if (item.id && item.id.trim().length > 0) {
    return sourceNameFromCatalogId(item.id);
  }

  const owner = sanitizeSourceName(item.providerName || "catalog");
  const title = sanitizeSourceName(item.name);
  if (!title || title === "api" || title === "openapi" || title === "graphql") {
    return owner;
  }
  return title;
}

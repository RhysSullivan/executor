import { parse as parseDomain } from "tldts";
import type {
  CredentialRecord,
  OpenApiSourceQuality,
  SourceAuthProfile,
  ToolSourceRecord,
} from "@/lib/types";

export type SourceAuthType = "none" | "bearer" | "apiKey" | "basic" | "mixed";
export type SourceAuthMode = "workspace" | "account" | "organization";

const RAW_HOSTS = new Set([
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "raw.github.com",
]);

export function getSourceFaviconUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    const parsed = parseDomain(hostname);
    const domain = parsed.domain ?? hostname;

    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  } catch {
    return null;
  }
}

function sourceFaviconSourceUrl(source: ToolSourceRecord): string | null {
  const parseOrigin = (value: unknown): string | null => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };

  if (source.type === "mcp") {
    return parseOrigin(source.config.url);
  }
  if (source.type === "graphql") {
    return parseOrigin(source.config.endpoint);
  }

  const spec = source.config.spec as string | undefined;
  const specUrl = source.config.specUrl as string | undefined;
  if (typeof spec === "string" && spec.startsWith("postman:")) {
    return null;
  }

  return parseOrigin(source.config.baseUrl)
    ?? parseOrigin(source.config.collectionUrl)
    ?? parseOrigin(specUrl)
    ?? parseOrigin(spec);
}

export function getSourceFavicon(source: ToolSourceRecord): string | null {
  const sourceUrl = sourceFaviconSourceUrl(source);
  return sourceUrl ? getSourceFaviconUrl(sourceUrl) : null;
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

export function sourceForCredentialKey(sources: ToolSourceRecord[], sourceKey: string): ToolSourceRecord | null {
  const prefix = "source:";
  if (!sourceKey.startsWith(prefix)) return null;
  const sourceId = sourceKey.slice(prefix.length);
  if (!sourceId) return null;
  return sources.find((source) => source.id === sourceId) ?? null;
}

export function parseWarningSourceName(warning: string): string | null {
  return warning.match(/source '([^']+)'/i)?.[1] ?? null;
}

export function warningsBySourceName(warnings: string[]): Record<string, string[]> {
  const messages: Record<string, string[]> = {};
  for (const warning of warnings) {
    const sourceName = parseWarningSourceName(warning);
    if (!sourceName) continue;
    messages[sourceName] ??= [];
    messages[sourceName].push(warning);
  }

  return messages;
}

export function sourceAuthProfileForSource(
  source: ToolSourceRecord,
  sourceAuthProfiles: Record<string, SourceAuthProfile>,
): SourceAuthProfile | undefined {
  const sourceKey = sourceKeyForSource(source);
  if (sourceKey && sourceAuthProfiles[sourceKey]) {
    return sourceAuthProfiles[sourceKey];
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

  const mode =
    profile.mode === "account" || profile.mode === "workspace" || profile.mode === "organization"
      ? profile.mode
      : undefined;
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
    auth && typeof auth.mode === "string"
      && (auth.mode === "workspace" || auth.mode === "account" || auth.mode === "organization")
      ? auth.mode as SourceAuthMode
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
  return `${authLabel} · ${mode === "account" ? "user" : "workspace"}`;
}

export function credentialStatsForSource(source: ToolSourceRecord, credentials: CredentialRecord[]): {
  workspaceCount: number;
  accountCount: number;
} {
  const sourceKey = sourceKeyForSource(source);
  if (!sourceKey) {
    return { workspaceCount: 0, accountCount: 0 };
  }

  let workspaceCount = 0;
  let accountCount = 0;
  for (const credential of credentials) {
    if (credential.sourceKey !== sourceKey) continue;
    if (credential.scopeType === "workspace") workspaceCount += 1;
    if (credential.scopeType === "account") accountCount += 1;
  }

  return { workspaceCount, accountCount };
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
    .replace(/-mcp$/, "")
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

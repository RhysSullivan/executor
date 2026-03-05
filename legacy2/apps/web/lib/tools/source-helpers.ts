import { parse as parseDomain } from "tldts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RAW_HOSTS = new Set([
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "raw.github.com",
]);

// ---------------------------------------------------------------------------
// Favicon URL helpers
// ---------------------------------------------------------------------------

/** Derive a Google favicon URL from any URL string using tldts for proper domain parsing. */
export function getSourceFaviconUrl(url: string | null | undefined): string | null {
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

// ---------------------------------------------------------------------------
// Seed-URL resolution (which URL to derive the favicon from)
// ---------------------------------------------------------------------------

function parseConfigJson(configJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function inferDomainFromRawUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (!RAW_HOSTS.has(parsed.hostname)) {
      return null;
    }

    const segments = parsed.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    for (const segment of segments) {
      const withoutExtension = segment.replace(/\.(ya?ml|json)$/i, "");
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(withoutExtension)) {
        return `https://${withoutExtension}`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve which URL to derive the favicon from based on source kind and config.
 * Returns the origin URL (seed), not the final Google favicon URL.
 */
export function sourceFaviconSeedUrl(source: {
  kind: string;
  endpoint: string;
  configJson: string;
}): string | null {
  const config = parseConfigJson(source.configJson);

  if (source.kind === "mcp") {
    return parseOrigin(config.url) ?? parseOrigin(source.endpoint);
  }

  if (source.kind === "graphql") {
    return parseOrigin(config.endpoint) ?? parseOrigin(source.endpoint);
  }

  const spec = config.spec;
  if (typeof spec === "string" && spec.startsWith("postman:")) {
    return null;
  }

  return (
    parseOrigin(config.baseUrl)
    ?? parseOrigin(config.collectionUrl)
    ?? inferDomainFromRawUrl(config.specUrl)
    ?? parseOrigin(config.specUrl)
    ?? inferDomainFromRawUrl(spec)
    ?? parseOrigin(spec)
    ?? inferDomainFromRawUrl(source.endpoint)
    ?? parseOrigin(source.endpoint)
  );
}

/** Convenience: resolve the final Google favicon URL for a source record. */
export function getSourceFavicon(source: {
  kind: string;
  endpoint: string;
  configJson: string;
}): string | null {
  const seedUrl = sourceFaviconSeedUrl(source);
  return seedUrl ? getSourceFaviconUrl(seedUrl) : null;
}

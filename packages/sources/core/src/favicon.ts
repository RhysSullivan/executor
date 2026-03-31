import { parse as parseDomain } from "tldts";

const RAW_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "raw.github.com",
  "raw.githubusercontent.com",
  "unpkg.com",
]);

const BRAND_DOMAINS: Record<string, string> = {
  anilist: "anilist.co",
  axiom: "axiom.co",
  chrome: "developer.chrome.com",
  deepwiki: "deepwiki.com",
  github: "github.com",
  gitlab: "gitlab.com",
  linear: "linear.app",
  neon: "neon.tech",
  openai: "openai.com",
  stripe: "stripe.com",
  vercel: "vercel.com",
};

const IGNORED_BRAND_TOKENS = new Set([
  "api", "app", "apps", "cli", "cloud", "com", "console", "dev",
  "docs", "doc", "graphql", "http", "https", "json", "latest",
  "mcp", "net", "none", "npm", "npx", "openapi", "org", "plugin",
  "plugins", "raw", "rest", "sdk", "server", "service", "services",
  "source", "sources", "stdio", "transport", "uv", "uvx", "yaml",
  "yarn", "yml",
]);

function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}

function domainFromHostname(hostname: string): string | null {
  const parsed = parseDomain(hostname);
  return parsed.domain ?? null;
}

function inferBrandDomain(value: string): string | null {
  const token = value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .find((t) => t.length > 1 && !IGNORED_BRAND_TOKENS.has(t) && !/^v?\d+$/.test(t));

  if (!token) {
    return null;
  }

  if (BRAND_DOMAINS[token]) {
    return BRAND_DOMAINS[token];
  }

  const parsed = parseDomain(token);
  return parsed.domain ?? `${token}.com`;
}

export function getFaviconUrlForRemoteUrl(
  value: string | null | undefined,
  options: {
    allowRawHosts?: boolean;
  } = {},
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    if (!options.allowRawHosts && RAW_HOSTS.has(url.hostname)) {
      return null;
    }

    const domain = domainFromHostname(url.hostname);
    return domain ? faviconUrl(domain) : null;
  } catch {
    return null;
  }
}

export function getSourceFaviconUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = (() => {
    try {
      return new URL(trimmed);
    } catch {
      try {
        return new URL(`https://${trimmed}`);
      } catch {
        return null;
      }
    }
  })();

  if (parsed) {
    if (RAW_HOSTS.has(parsed.hostname)) {
      const segments = parsed.pathname
        .split("/")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const segment of segments) {
        const base = segment.replace(/\.(ya?ml|json)$/i, "");
        const domain = domainFromHostname(base) ?? inferBrandDomain(base);
        if (domain) {
          return faviconUrl(domain);
        }
      }
    }

    const domain = domainFromHostname(parsed.hostname) ?? inferBrandDomain(parsed.hostname);
    return domain ? faviconUrl(domain) : null;
  }

  const domain = inferBrandDomain(trimmed);
  return domain ? faviconUrl(domain) : null;
}

export function getFallbackSourceFaviconUrl(input: {
  namespace?: string | null;
  name?: string | null;
}): string | null {
  return getSourceFaviconUrl(input.namespace)
    ?? getSourceFaviconUrl(input.name);
}

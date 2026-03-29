import { parse as parseDomain } from "tldts";

const RAW_HOSTS = new Set([
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net",
  "raw.github.com",
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
  "api",
  "app",
  "apps",
  "cli",
  "cloud",
  "com",
  "console",
  "dev",
  "docs",
  "doc",
  "graphql",
  "http",
  "https",
  "json",
  "latest",
  "mcp",
  "net",
  "none",
  "npm",
  "npx",
  "openapi",
  "org",
  "plugin",
  "plugins",
  "raw",
  "rest",
  "sdk",
  "server",
  "service",
  "services",
  "source",
  "sources",
  "stdio",
  "transport",
  "uv",
  "uvx",
  "yaml",
  "yarn",
  "yml",
]);

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const toDomainSeedUrl = (value: string): string | null => {
  const parsed = parseDomain(value);
  const domain = parsed.domain ?? BRAND_DOMAINS[value] ?? null;
  return domain ? `https://${domain}` : null;
};

const isMeaninglessToken = (token: string): boolean =>
  token.length <= 1
  || IGNORED_BRAND_TOKENS.has(token)
  || /^v?\d+$/.test(token);

const inferBrandToken = (value: string): string | null => {
  const token = value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .find((candidate) => !isMeaninglessToken(candidate));

  return token && token.length > 0 ? token : null;
};

const toBrandSeedUrl = (value: string): string | null => {
  const brand = inferBrandToken(value);
  if (!brand) {
    return null;
  }

  return `https://${BRAND_DOMAINS[brand] ?? `${brand}.com`}`;
};

const normalizeSeedUrl = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseUrl(trimmed) ?? parseUrl(`https://${trimmed}`);
  if (parsed) {
    if (RAW_HOSTS.has(parsed.hostname)) {
      const segments = parsed.pathname
        .split("/")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);

      for (const segment of segments) {
        const withoutExtension = segment.replace(/\.(ya?ml|json)$/i, "");
        const seeded =
          toDomainSeedUrl(withoutExtension)
          ?? toBrandSeedUrl(withoutExtension);
        if (seeded) {
          return seeded;
        }
      }
    }

    return toDomainSeedUrl(parsed.hostname) ?? toBrandSeedUrl(parsed.hostname);
  }

  return toDomainSeedUrl(trimmed) ?? toBrandSeedUrl(trimmed);
};

export const getSourceFaviconUrl = (
  value: string | null | undefined,
): string | null => {
  const seedUrl = normalizeSeedUrl(value);
  if (!seedUrl) {
    return null;
  }

  try {
    const hostname = new URL(seedUrl).hostname;
    const parsed = parseDomain(hostname);
    const domain = parsed.domain ?? hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  } catch {
    return null;
  }
};

export const getFallbackSourceFaviconUrl = (input: {
  namespace?: string | null;
  name?: string | null;
}): string | null =>
  getSourceFaviconUrl(input.namespace)
  ?? getSourceFaviconUrl(input.name);

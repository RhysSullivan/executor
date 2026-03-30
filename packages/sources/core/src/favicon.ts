import { parse as parseDomain } from "tldts";

const RAW_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "raw.github.com",
  "raw.githubusercontent.com",
  "unpkg.com",
]);

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

    const parsed = parseDomain(url.hostname);
    const domain = parsed.domain ?? url.hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  } catch {
    return null;
  }
}

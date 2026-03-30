const COMMON_COMPOUND_SUFFIXES = new Set([
  "ac.uk",
  "co.in",
  "co.jp",
  "co.nz",
  "co.uk",
  "com.au",
  "com.br",
  "com.mx",
  "net.au",
  "org.au",
  "org.uk",
]);

const RAW_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "raw.github.com",
  "raw.githubusercontent.com",
  "unpkg.com",
]);

function trimOrNull(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isIpv4Address(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

export function getRegistrableDomain(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized) {
    return null;
  }

  if (normalized === "localhost" || isIpv4Address(normalized)) {
    return normalized;
  }

  const parts = normalized.split(".").filter((part) => part.length > 0);
  if (parts.length < 2) {
    return null;
  }

  const suffix = parts.slice(-2).join(".");
  if (parts.length >= 3 && COMMON_COMPOUND_SUFFIXES.has(suffix)) {
    return parts.slice(-3).join(".");
  }

  return parts.slice(-2).join(".");
}

export function getFaviconUrlForRemoteUrl(
  value: string | null | undefined,
  options: {
    allowRawHosts?: boolean;
  } = {},
): string | null {
  const trimmed = trimOrNull(value);
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

    const domain = getRegistrableDomain(url.hostname);
    return domain
      ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`
      : null;
  } catch {
    return null;
  }
}

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

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIpv4Address = (value: string): boolean =>
  /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);

const toRegistrableDomain = (hostname: string): string | null => {
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
};

const toGoogleFaviconUrl = (domain: string): string =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;

export const resolveSourceIconUrl = (input: {
  configuredIconUrl?: string | null;
  kind: string;
  config?: unknown;
}): string | null => {
  const configuredIconUrl = trimOrNull(input.configuredIconUrl);
  if (configuredIconUrl) {
    return configuredIconUrl;
  }

  if (input.kind !== "mcp" || !isRecord(input.config)) {
    return null;
  }

  const endpoint = typeof input.config.endpoint === "string"
    ? trimOrNull(input.config.endpoint)
    : null;
  if (!endpoint) {
    return null;
  }

  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    const domain = toRegistrableDomain(url.hostname);
    return domain ? toGoogleFaviconUrl(domain) : null;
  } catch {
    return null;
  }
};

import { isIP } from "node:net";
import { Result } from "better-result";
import { parse as parseDomain } from "tldts";

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeIpHost(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) {
    return true;
  }

  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    return isPrivateIpv4(mapped);
  }

  return false;
}

function isPrivateIp(hostname: string): boolean {
  const normalized = normalizeIpHost(hostname);
  const family = isIP(normalized);
  if (family === 4) {
    return isPrivateIpv4(normalized);
  }
  if (family === 6) {
    return isPrivateIpv6(normalized);
  }
  return false;
}

function isPublicDnsHostname(hostname: string): boolean {
  const parsed = parseDomain(hostname);
  return Boolean(parsed.domain && parsed.publicSuffix);
}

export function parseMcpSourceUrl(raw: string): Result<URL, Error> {
  return Result.try({
    try: () => {
      const url = new URL(raw);
      const protocol = url.protocol.toLowerCase();
      const hostname = url.hostname.toLowerCase();

      if (url.username || url.password) {
        throw new Error("Credentials in MCP source URL are not allowed");
      }

      if (protocol !== "https:" && protocol !== "http:") {
        throw new Error("MCP source URL must use https:// (or http:// for localhost in dev)");
      }

      const localAllowed = process.env.NODE_ENV !== "production" || process.env.EXECUTOR_ALLOW_LOCAL_MCP_OAUTH === "1";
      if (protocol === "http:" && !(localAllowed && isLocalHost(hostname))) {
        throw new Error("MCP source URL must use https://");
      }

      if (isPrivateIp(hostname) && !(localAllowed && isLocalHost(hostname))) {
        throw new Error("Private or local MCP hosts are not allowed");
      }

      if (!isIP(normalizeIpHost(hostname)) && !isPublicDnsHostname(hostname)) {
        throw new Error("MCP source host must be a public DNS host");
      }

      return url;
    },
    catch: (error) =>
      error instanceof Error
        ? error
        : new Error(String(error)),
  });
}

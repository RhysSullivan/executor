import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parse as parseDomain } from "tldts";
import { z } from "zod";
import { inspectOpenApiPayload } from "@/lib/openapi/spec-inspector";

const INSPECTION_TIMEOUT_MS = 12_000;

const requestSchema = z.object({
  specUrl: z.string().trim().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

const blockedForwardedHeaderNames = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-length",
  "content-type",
  "host",
  "origin",
  "referer",
]);

function noStoreJson(payload: unknown, status: number): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

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

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && (error as { name?: unknown }).name === "AbortError";
}

function sanitizeForwardHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  const nextHeaders: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) {
      continue;
    }
    if (blockedForwardedHeaderNames.has(key.toLowerCase())) {
      continue;
    }
    nextHeaders[key] = value;
  }

  return nextHeaders;
}

function extractErrorDetail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const candidates = ["message", "error", "detail", "title", "description"];
    for (const key of candidates) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().slice(0, 300);
      }
    }
  } catch {
    // Fall through to plain-text detail.
  }

  return trimmed.replace(/\s+/g, " ").slice(0, 300);
}

export async function POST(request: NextRequest) {
  const parsedRequest = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsedRequest.success) {
    return noStoreJson({ detail: "Invalid OpenAPI inspection request" }, 400);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(parsedRequest.data.specUrl);
  } catch {
    return noStoreJson({ detail: "Spec URL is invalid" }, 400);
  }

  const protocol = parsedUrl.protocol.toLowerCase();
  const hostname = parsedUrl.hostname.toLowerCase();
  const localAllowed = process.env.NODE_ENV !== "production";

  if (parsedUrl.username || parsedUrl.password) {
    return noStoreJson({ detail: "Credentials in spec URL are not allowed" }, 400);
  }

  if (protocol !== "https:" && protocol !== "http:") {
    return noStoreJson({ detail: "Spec URL must use https:// (or http:// for localhost in dev)" }, 400);
  }

  if (protocol === "http:" && !(localAllowed && isLocalHost(hostname))) {
    return noStoreJson({ detail: "Spec URL must use https://" }, 400);
  }

  if (isPrivateIp(hostname) && !(localAllowed && isLocalHost(hostname))) {
    return noStoreJson({ detail: "Private or local hosts are not allowed" }, 400);
  }

  if (!isIP(normalizeIpHost(hostname)) && !isPublicDnsHostname(hostname)) {
    return noStoreJson({ detail: "Spec host must be a public DNS host" }, 400);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INSPECTION_TIMEOUT_MS);

  try {
    const response = await fetch(parsedUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.8",
        ...sanitizeForwardHeaders(parsedRequest.data.headers),
      },
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      const detail = extractErrorDetail(await response.text().catch(() => ""));
      return noStoreJson({
        status: response.status,
        statusText: response.statusText,
        detail,
      }, response.status);
    }

    const raw = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const inspected = inspectOpenApiPayload({
      raw,
      sourceUrl: parsedUrl.toString(),
      contentType,
    });

    return noStoreJson({
      status: response.status,
      statusText: response.statusText,
      spec: inspected.spec,
      inferredAuth: inspected.inferredAuth,
    }, 200);
  } catch (error) {
    if (isAbortError(error)) {
      return noStoreJson({ detail: "Request timed out while fetching spec" }, 504);
    }

    const detail = error instanceof Error ? error.message : "Failed to fetch spec";
    return noStoreJson({ detail }, 502);
  } finally {
    clearTimeout(timeoutId);
  }
}

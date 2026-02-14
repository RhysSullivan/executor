import type { NextRequest } from "next/server";
import { Result } from "better-result";

function firstHeaderValue(value: string | null): string {
  if (!value) {
    return "";
  }
  return value.split(",")[0]?.trim() ?? "";
}

function configuredExternalOrigin(): string | null {
  const configured =
    process.env.EXECUTOR_PUBLIC_ORIGIN
    ?? process.env.NEXT_PUBLIC_EXECUTOR_HTTP_URL
    ?? "";
  if (!configured.trim()) {
    return null;
  }

  const parsed = Result.try(() => new URL(configured));
  if (!parsed.isOk()) {
    return null;
  }
  return parsed.value.origin;
}

export function getExternalOrigin(request: NextRequest): string {
  const configured = configuredExternalOrigin();
  if (configured) {
    return configured;
  }

  const host = firstHeaderValue(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
  const proto = firstHeaderValue(request.headers.get("x-forwarded-proto"))
    || request.nextUrl.protocol.replace(":", "");
  if (host && proto) {
    const parsed = Result.try(() => new URL(`${proto}://${host}`));
    if (parsed.isOk()) {
      return parsed.value.origin;
    }
  }
  return request.nextUrl.origin;
}

export function isExternalHttps(request: NextRequest): boolean {
  const origin = getExternalOrigin(request);
  return origin.startsWith("https://");
}

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
    ?? process.env.EXECUTOR_HTTP_URL
    ?? process.env.VITE_EXECUTOR_HTTP_URL
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

export function getExternalOrigin(request: Request): string {
  const configured = configuredExternalOrigin();
  if (configured) {
    return configured;
  }

  const host = firstHeaderValue(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
  const requestUrl = new URL(request.url);
  const proto = firstHeaderValue(request.headers.get("x-forwarded-proto"))
    || requestUrl.protocol.replace(":", "");
  if (host && proto) {
    const parsed = Result.try(() => new URL(`${proto}://${host}`));
    if (parsed.isOk()) {
      return parsed.value.origin;
    }
  }
  return requestUrl.origin;
}

export function isExternalHttps(request: Request): boolean {
  const origin = getExternalOrigin(request);
  return origin.startsWith("https://");
}

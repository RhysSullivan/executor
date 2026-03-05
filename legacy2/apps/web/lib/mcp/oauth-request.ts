import { configuredExternalOriginFromEnv } from "../external-origin";

const firstHeaderValue = (value: string | null): string => {
  if (!value) {
    return "";
  }

  return value.split(",")[0]?.trim() ?? "";
};

export const getExternalOrigin = (request: Request): string => {
  const configured = configuredExternalOriginFromEnv();
  if (configured) {
    return configured;
  }

  const host = firstHeaderValue(
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  );
  const requestUrl = new URL(request.url);
  const proto =
    firstHeaderValue(request.headers.get("x-forwarded-proto"))
    || requestUrl.protocol.replace(":", "");

  if (host && proto) {
    try {
      return new URL(`${proto}://${host}`).origin;
    } catch {
      return requestUrl.origin;
    }
  }

  return requestUrl.origin;
};

export const isExternalHttps = (request: Request): boolean =>
  getExternalOrigin(request).startsWith("https://");

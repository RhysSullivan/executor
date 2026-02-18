function firstHeaderValue(value: string | null): string {
  if (!value) {
    return "";
  }

  return value.split(",")[0]?.trim() ?? "";
}

export function externalOriginFromRequest(request: Request): string {
  const requestUrl = new URL(request.url);
  const host = firstHeaderValue(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
  const proto = firstHeaderValue(request.headers.get("x-forwarded-proto"))
    || requestUrl.protocol.replace(":", "");

  if (host && proto) {
    return `${proto}://${host}`;
  }

  return requestUrl.origin;
}

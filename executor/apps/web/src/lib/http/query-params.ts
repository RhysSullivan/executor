export function readOptionalQueryParam(url: URL, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

export function readOptionalReferrerQueryParam(request: Request, keys: string[]): string | undefined {
  const referrer = request.headers.get("referer");
  if (!referrer) {
    return undefined;
  }

  let referrerUrl: URL;
  try {
    referrerUrl = new URL(referrer);
  } catch {
    return undefined;
  }

  return readOptionalQueryParam(referrerUrl, keys);
}

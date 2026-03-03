const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

export const isWorkosEnabled = (): boolean => {
  return Boolean(
    trim(process.env.WORKOS_CLIENT_ID) && trim(process.env.WORKOS_API_KEY),
  );
};

export const externalOriginFromRequest = (request: Request): string => {
  const forwardedHost = trim(request.headers.get("x-forwarded-host") ?? undefined);
  const forwardedProto = trim(request.headers.get("x-forwarded-proto") ?? undefined);

  if (forwardedHost) {
    const protocol = forwardedProto ?? "https";
    return `${protocol}://${forwardedHost}`;
  }

  return new URL(request.url).origin;
};

const fallbackOrigin = (): string | undefined => {
  const explicit = trim(process.env.NEXT_PUBLIC_APP_ORIGIN);
  if (explicit) {
    return explicit;
  }

  const vercelHost = trim(process.env.VERCEL_PROJECT_PRODUCTION_URL) ?? trim(process.env.VERCEL_URL);
  if (vercelHost) {
    return vercelHost.startsWith("http://") || vercelHost.startsWith("https://")
      ? vercelHost
      : `https://${vercelHost}`;
  }

  if (trim(process.env.NODE_ENV) !== "production") {
    return "http://localhost:4312";
  }

  return undefined;
};

export const resolveWorkosRedirectUri = (request?: Request): string | undefined => {
  const explicitRedirect = trim(process.env.WORKOS_REDIRECT_URI);
  if (explicitRedirect) {
    return explicitRedirect;
  }

  const publicRedirect = trim(process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI);
  if (publicRedirect) {
    return publicRedirect;
  }

  const origin = request ? externalOriginFromRequest(request) : fallbackOrigin();
  return origin ? `${origin}/callback` : undefined;
};

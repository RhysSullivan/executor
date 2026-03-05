import { webPublicEnvironment } from "./env/public";
import { webServerEnvironment } from "./env/server";

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

export const isWorkosEnabled = (): boolean => {
  return Boolean(webServerEnvironment.workosClientId && webServerEnvironment.workosApiKey);
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
  const explicit = webPublicEnvironment.nextPublicAppOrigin;
  if (explicit) {
    return explicit;
  }

  const vercelHost =
    webServerEnvironment.vercelProjectProductionUrl ?? webServerEnvironment.vercelUrl;
  if (vercelHost) {
    return vercelHost.startsWith("http://") || vercelHost.startsWith("https://")
      ? vercelHost
      : `https://${vercelHost}`;
  }

  if (webServerEnvironment.nodeEnv !== "production") {
    return "http://localhost:4312";
  }

  return undefined;
};

export const resolveWorkosRedirectUri = (request?: Request): string | undefined => {
  const explicitRedirect = webServerEnvironment.workosRedirectUri;
  if (explicitRedirect) {
    return explicitRedirect;
  }

  const publicRedirect = webPublicEnvironment.nextPublicWorkosRedirectUri;
  if (publicRedirect) {
    return publicRedirect;
  }

  const origin = request ? externalOriginFromRequest(request) : fallbackOrigin();
  return origin ? `${origin}/callback` : undefined;
};

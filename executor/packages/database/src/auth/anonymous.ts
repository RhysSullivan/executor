export const ANONYMOUS_AUTH_AUDIENCE = "executor-anonymous";
export const ANONYMOUS_AUTH_KEY_ID = "executor-anonymous-es256";
export const ANONYMOUS_AUTH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

function trimOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function toSiteUrl(raw: string | undefined): string | null {
  const trimmed = trimOrNull(raw);
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.endsWith(".convex.cloud")) {
      parsed.hostname = parsed.hostname.replace(/\.convex\.cloud$/, ".convex.site");
    }
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function getAnonymousAuthIssuer(): string | null {
  return toSiteUrl(process.env.ANONYMOUS_AUTH_ISSUER)
    ?? toSiteUrl(process.env.CONVEX_SITE_URL)
    ?? toSiteUrl(process.env.CONVEX_URL);
}

export function getAnonymousAuthJwksUrl(): string | null {
  const issuer = getAnonymousAuthIssuer();
  return issuer ? `${issuer}/.well-known/jwks.json` : null;
}

export function isAnonymousIdentity(identity: { subject?: unknown; provider?: unknown } | null): boolean {
  if (!identity || typeof identity.subject !== "string") {
    return false;
  }
  return identity.provider === "anonymous";
}

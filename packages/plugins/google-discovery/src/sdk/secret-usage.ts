import type { GoogleDiscoveryStoredSource } from "./binding-store";

export const collectGoogleDiscoverySecretIds = (
  source: GoogleDiscoveryStoredSource,
): readonly string[] => {
  const auth = source.config.auth;
  if (auth.kind !== "oauth2") return [];

  return [
    auth.clientIdSecretId,
    auth.clientSecretSecretId,
    auth.accessTokenSecretId,
    auth.refreshTokenSecretId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
};

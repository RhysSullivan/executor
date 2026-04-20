import type { StoredSource } from "./store";

const collectHeaderSecretIds = (headers: StoredSource["config"]["headers"]): readonly string[] => {
  if (!headers) return [];
  const secretIds = new Set<string>();
  for (const value of Object.values(headers)) {
    if (
      value &&
      typeof value === "object" &&
      "secretId" in value &&
      typeof value.secretId === "string" &&
      value.secretId.length > 0
    ) {
      secretIds.add(value.secretId);
    }
  }
  return [...secretIds];
};

export const collectOpenApiSecretIds = (source: StoredSource): readonly string[] => {
  const secretIds = new Set(collectHeaderSecretIds(source.config.headers));
  const oauth2 = source.config.oauth2;
  if (oauth2?.kind === "oauth2") {
    for (const secretId of [
      oauth2.clientIdSecretId,
      oauth2.clientSecretSecretId,
      oauth2.accessTokenSecretId,
      oauth2.refreshTokenSecretId,
    ]) {
      if (typeof secretId === "string" && secretId.length > 0) {
        secretIds.add(secretId);
      }
    }
  }
  return [...secretIds];
};

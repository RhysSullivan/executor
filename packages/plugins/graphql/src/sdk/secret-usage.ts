import type { StoredGraphqlSource } from "./store";

export const collectGraphqlSecretIds = (source: StoredGraphqlSource): readonly string[] => {
  const secretIds = new Set<string>();
  for (const value of Object.values(source.headers)) {
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

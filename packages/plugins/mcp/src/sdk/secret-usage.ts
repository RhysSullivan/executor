import type { McpStoredSource } from "./binding-store";

export const collectMcpSecretIds = (source: McpStoredSource): readonly string[] => {
  if (source.config.transport !== "remote") return [];

  const auth = source.config.auth;
  if (!auth) return [];

  switch (auth.kind) {
    case "header":
      return typeof auth.secretId === "string" && auth.secretId.length > 0 ? [auth.secretId] : [];
    case "oauth2":
      return [auth.accessTokenSecretId, auth.refreshTokenSecretId].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
    default:
      return [];
  }
};

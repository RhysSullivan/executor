// ---------------------------------------------------------------------------
// Transforms between file shapes (McpAuthConfig, ConfigHeaderValue) and
// runtime shapes (McpConnectionAuth, PluginHeaderValue).
//
// Paired: `xToConfig` writes the file, `xFromConfig` reads it. Kept in a
// single file so a new auth kind or header form has to touch both
// halves — and the roundtrip tests in `transform.test.ts` prove the
// pair is a true inverse.
// ---------------------------------------------------------------------------

import {
  SECRET_REF_PREFIX,
  type ConfigHeaderValue,
  type McpAuthConfig,
  type McpConnectionAuth,
} from "./schema";

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Runtime shape a plugin hands to its `addSource` / `addSpec` call — either
 *  a literal header value or a reference to a secret plus optional prefix. */
export type PluginHeaderValue = string | { secretId: string; prefix?: string };

export const headerToConfigValue = (
  value: PluginHeaderValue,
): ConfigHeaderValue => {
  if (typeof value === "string") return value;
  const ref = `${SECRET_REF_PREFIX}${value.secretId}`;
  return value.prefix ? { value: ref, prefix: value.prefix } : ref;
};

export const headersToConfigValues = (
  headers: Record<string, PluginHeaderValue> | undefined,
): Record<string, ConfigHeaderValue> | undefined => {
  if (!headers) return undefined;
  const out: Record<string, ConfigHeaderValue> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = headerToConfigValue(v);
  return out;
};

const stripSecretRef = (value: string): string =>
  value.startsWith(SECRET_REF_PREFIX)
    ? value.slice(SECRET_REF_PREFIX.length)
    : value;

export const headerFromConfigValue = (
  value: ConfigHeaderValue,
): PluginHeaderValue => {
  if (typeof value === "string") {
    return value.startsWith(SECRET_REF_PREFIX)
      ? { secretId: stripSecretRef(value) }
      : value;
  }
  if (value.value.startsWith(SECRET_REF_PREFIX)) {
    return { secretId: stripSecretRef(value.value), prefix: value.prefix };
  }
  return value.value;
};

export const headersFromConfigValues = (
  headers: Record<string, ConfigHeaderValue> | undefined,
): Record<string, PluginHeaderValue> | undefined => {
  if (!headers) return undefined;
  const out: Record<string, PluginHeaderValue> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = headerFromConfigValue(v);
  return out;
};

// ---------------------------------------------------------------------------
// MCP connection auth
//
// `none` and `oauth2` are identical across shapes — oauth2 stores only a
// stable `connectionId`, with token material off on the Connection row.
// `header` differs: file `secret` is `secret-public-ref:<id>`; runtime
// `secretId` is bare.
// ---------------------------------------------------------------------------

export const mcpAuthToConfig = (
  auth: McpConnectionAuth | undefined,
): McpAuthConfig | undefined => {
  if (!auth) return undefined;
  if (auth.kind === "header") {
    return {
      kind: "header",
      headerName: auth.headerName,
      secret: `${SECRET_REF_PREFIX}${auth.secretId}`,
      prefix: auth.prefix,
    };
  }
  return auth;
};

export const mcpAuthFromConfig = (
  auth: McpAuthConfig | undefined,
): McpConnectionAuth | undefined => {
  if (!auth) return undefined;
  if (auth.kind === "header") {
    return {
      kind: "header",
      headerName: auth.headerName,
      secretId: stripSecretRef(auth.secret),
      prefix: auth.prefix,
    };
  }
  return auth;
};

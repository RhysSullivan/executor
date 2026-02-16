import type { InferredSpecAuth } from "@/lib/openapi/spec-inspector";
import { readSourceAuth } from "@/lib/tools/source-helpers";
import type {
  CredentialRecord,
  CredentialScope,
  SourceAuthType,
  ToolSourceScopeType,
  ToolSourceRecord,
} from "@/lib/types";
import type { SourceCatalogSort, SourceType } from "./dialog-helpers";

export type SourceDialogView = "catalog" | "custom";

export type SourceFormValues = {
  type: SourceType;
  scopeType: ToolSourceScopeType;
  name: string;
  endpoint: string;
  baseUrl: string;
  mcpTransport: "auto" | "streamable-http" | "sse";
  authType: Exclude<SourceAuthType, "mixed">;
  authScope: CredentialScope;
  apiKeyHeader: string;
  tokenValue: string;
  apiKeyValue: string;
  basicUsername: string;
  basicPassword: string;
};

export function createDefaultFormValues(): SourceFormValues {
  return {
    type: "mcp",
    scopeType: "workspace",
    name: "",
    endpoint: "",
    baseUrl: "",
    mcpTransport: "auto",
    authType: "none",
    authScope: "account",
    apiKeyHeader: "x-api-key",
    tokenValue: "",
    apiKeyValue: "",
    basicUsername: "",
    basicPassword: "",
  };
}

export type AddSourceUiState = {
  view: SourceDialogView;
  catalogQuery: string;
  catalogSort: SourceCatalogSort;
  openApiBaseUrlOptions: string[];
  locallyReservedNames: string[];
  authManuallyEdited: boolean;
  authRevision: number;
  mcpOAuthLinkedEndpoint: string | null;
  /** True when the type was explicitly chosen by the user or from a catalog item. */
  typeExplicitlySet: boolean;
};

export function createDefaultUiState(view: SourceDialogView = "catalog"): AddSourceUiState {
  return {
    view,
    catalogQuery: "",
    catalogSort: "popular",
    openApiBaseUrlOptions: [],
    locallyReservedNames: [],
    authManuallyEdited: false,
    authRevision: 0,
    mcpOAuthLinkedEndpoint: null,
    typeExplicitlySet: false,
  };
}

export function deriveBaseUrlFromEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    return parsed.origin;
  } catch {
    return "";
  }
}

export function deriveBaseUrlOptionsFromSpec(spec: Record<string, unknown>, endpoint: string): string[] {
  const servers = Array.isArray(spec.servers)
    ? spec.servers.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];
  const values: string[] = [];
  const seen = new Set<string>();

  for (const server of servers) {
    const urlValue = typeof server.url === "string" ? server.url.trim() : "";
    if (!urlValue) continue;

    try {
      const resolved = new URL(urlValue, endpoint).toString();
      if (!seen.has(resolved)) {
        seen.add(resolved);
        values.push(resolved);
      }
    } catch {
      // Ignore invalid server URL entries.
    }
  }

  if (values.length > 0) {
    return values;
  }

  const endpointOrigin = deriveBaseUrlFromEndpoint(endpoint);
  return endpointOrigin ? [endpointOrigin] : [];
}

export function deriveServerBaseUrlOptionsFromSpec(spec: Record<string, unknown>, endpoint: string): string[] {
  const servers = Array.isArray(spec.servers)
    ? spec.servers.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];
  const values: string[] = [];
  const seen = new Set<string>();

  for (const server of servers) {
    const urlValue = typeof server.url === "string" ? server.url.trim() : "";
    if (!urlValue) continue;

    try {
      const resolved = new URL(urlValue, endpoint).toString();
      if (!seen.has(resolved)) {
        seen.add(resolved);
        values.push(resolved);
      }
    } catch {
      // Ignore invalid server URL entries.
    }
  }

  return values;
}

export function sourceTypeFromRecord(source: ToolSourceRecord): SourceType {
  return source.type === "mcp" || source.type === "openapi" || source.type === "graphql"
    ? source.type
    : "mcp";
}

export function endpointFromSource(source: ToolSourceRecord): string {
  if (source.type === "mcp") {
    return typeof source.config.url === "string" ? source.config.url : "";
  }
  if (source.type === "graphql") {
    return typeof source.config.endpoint === "string" ? source.config.endpoint : "";
  }
  if (typeof source.config.specUrl === "string" && source.config.specUrl.trim().length > 0) {
    return source.config.specUrl;
  }
  return typeof source.config.spec === "string" ? source.config.spec : "";
}

export function sourceToFormValues(source: ToolSourceRecord): SourceFormValues {
  const sourceType = sourceTypeFromRecord(source);
  const auth = readSourceAuth(source);

  return {
    type: sourceType,
    scopeType: source.scopeType ?? "workspace",
    name: source.name,
    endpoint: endpointFromSource(source),
    baseUrl: typeof source.config.baseUrl === "string" ? source.config.baseUrl : "",
    mcpTransport:
      sourceType === "mcp" && (source.config.transport === "streamable-http" || source.config.transport === "sse")
        ? source.config.transport
        : "auto",
    authType: auth.type === "mixed" ? "bearer" : auth.type,
    authScope: auth.mode ?? "workspace",
    apiKeyHeader: auth.header ?? "x-api-key",
    tokenValue: "",
    apiKeyValue: "",
    basicUsername: "",
    basicPassword: "",
  };
}

export function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function existingCredentialMatchesAuthType(
  credential: CredentialRecord,
  authType: Exclude<SourceAuthType, "mixed">,
): boolean {
  const secret = credential.secretJson ?? {};

  if (authType === "bearer") {
    return typeof secret.token === "string" && secret.token.trim().length > 0;
  }
  if (authType === "apiKey") {
    return typeof secret.value === "string" && secret.value.trim().length > 0;
  }
  if (authType === "basic") {
    return typeof secret.username === "string"
      && secret.username.trim().length > 0
      && typeof secret.password === "string"
      && secret.password.trim().length > 0;
  }

  return true;
}

export function buildAuthConfig(values: SourceFormValues): Record<string, unknown> | undefined {
  if (values.authType === "none") {
    return { type: "none" };
  }
  if (values.authType === "apiKey") {
    return {
      type: "apiKey",
      mode: values.authScope,
      header: values.apiKeyHeader.trim() || "x-api-key",
    };
  }
  if (values.authType === "basic") {
    return {
      type: "basic",
      mode: values.authScope,
    };
  }
  return {
    type: "bearer",
    mode: values.authScope,
  };
}

export function buildSecretJson(values: SourceFormValues): { value?: Record<string, unknown>; error?: string } {
  if (values.authType === "none") {
    return { value: undefined };
  }

  if (values.authType === "apiKey") {
    const trimmed = values.apiKeyValue.trim();
    if (!trimmed) {
      return { error: "API key value is required" };
    }
    return { value: { value: trimmed } };
  }

  if (values.authType === "basic") {
    const username = values.basicUsername.trim();
    const password = values.basicPassword.trim();
    if (!username || !password) {
      return { error: "Username and password are required" };
    }
    return { value: { username, password } };
  }

  const token = values.tokenValue.trim();
  if (!token) {
    return { error: "Bearer token is required" };
  }
  return { value: { token } };
}

export function hasCredentialInput(values: SourceFormValues): boolean {
  if (values.authType === "bearer") {
    return values.tokenValue.trim().length > 0;
  }
  if (values.authType === "apiKey") {
    return values.apiKeyValue.trim().length > 0;
  }
  if (values.authType === "basic") {
    return values.basicUsername.trim().length > 0 || values.basicPassword.trim().length > 0;
  }
  return false;
}

export function inferAuthPatch(inferredAuth: InferredSpecAuth): Pick<SourceFormValues, "authType" | "authScope" | "apiKeyHeader"> {
  if (inferredAuth.type === "mixed") {
    return {
      authType: "bearer",
      authScope: inferredAuth.mode ?? "workspace",
      apiKeyHeader: "x-api-key",
    };
  }

  return {
    authType: inferredAuth.type,
    authScope: inferredAuth.mode ?? "workspace",
    apiKeyHeader: inferredAuth.type === "apiKey"
      ? inferredAuth.header ?? "x-api-key"
      : "x-api-key",
  };
}

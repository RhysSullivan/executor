import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const COOKIE_PREFIX = "executor_v2_mcp_oauth_";
export const MCP_OAUTH_RESULT_COOKIE = "executor_v2_mcp_oauth_result";

export type McpOAuthPending = {
  state: string;
  sourceUrl: string;
  redirectUrl: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
};

export type McpOAuthPopupResult = {
  ok: boolean;
  sourceUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  scope?: string;
  expiresIn?: number;
  clientId?: string;
  clientInformationJson?: string;
  error?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const readString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" ? value : null;
};

const readOptionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const readOptionalNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
};

const decodeCookieJson = (raw: string): unknown | null => {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
};

const decodePending = (value: unknown): McpOAuthPending | null => {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const state = readString(record, "state");
  const sourceUrl = readString(record, "sourceUrl");
  const redirectUrl = readString(record, "redirectUrl");

  if (!state || !sourceUrl || !redirectUrl) {
    return null;
  }

  const codeVerifier = readOptionalString(record, "codeVerifier");
  const clientInformationValue = record.clientInformation;
  const clientInformation = asRecord(clientInformationValue)
    ? (clientInformationValue as OAuthClientInformationMixed)
    : undefined;

  return {
    state,
    sourceUrl,
    redirectUrl,
    ...(codeVerifier ? { codeVerifier } : {}),
    ...(clientInformation ? { clientInformation } : {}),
  };
};

const decodePopupResult = (value: unknown): McpOAuthPopupResult | null => {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const ok = record.ok;
  if (typeof ok !== "boolean") {
    return null;
  }

  return {
    ok,
    sourceUrl: readOptionalString(record, "sourceUrl"),
    accessToken: readOptionalString(record, "accessToken"),
    refreshToken: readOptionalString(record, "refreshToken"),
    scope: readOptionalString(record, "scope"),
    expiresIn: readOptionalNumber(record, "expiresIn"),
    clientId: readOptionalString(record, "clientId"),
    clientInformationJson: readOptionalString(record, "clientInformationJson"),
    error: readOptionalString(record, "error"),
  };
};

export const buildPendingCookieName = (state: string): string =>
  `${COOKIE_PREFIX}${state}`;

export const createOAuthState = (): string => randomUUID();

export const encodePendingCookieValue = (pending: McpOAuthPending): string =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      pending,
    }),
    "utf8",
  ).toString("base64url");

export const decodePendingCookieValue = (raw: string): McpOAuthPending | null => {
  const decoded = decodeCookieJson(raw);
  const versioned = asRecord(decoded);
  if (!versioned || versioned.version !== 1) {
    return null;
  }

  return decodePending(versioned.pending);
};

export const encodePopupResultCookieValue = (result: McpOAuthPopupResult): string =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      result,
    }),
    "utf8",
  ).toString("base64url");

export const decodePopupResultCookieValue = (
  raw: string,
): McpOAuthPopupResult | null => {
  const decoded = decodeCookieJson(raw);
  const versioned = asRecord(decoded);
  if (!versioned || versioned.version !== 1) {
    return null;
  }

  return decodePopupResult(versioned.result);
};

export class McpPopupOAuthProvider implements OAuthClientProvider {
  public clientMetadata: OAuthClientMetadata;

  private readonly stateValue: string;
  private readonly redirectTarget: string;
  private codeVerifierValue?: string;
  private clientInfo?: OAuthClientInformationMixed;
  private tokenValue?: OAuthTokens;
  private authorizationUrl?: string;

  constructor(input: {
    redirectUrl: string;
    state: string;
    codeVerifier?: string;
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
  }) {
    this.redirectTarget = input.redirectUrl;
    this.stateValue = input.state;
    this.codeVerifierValue = input.codeVerifier;
    this.clientInfo = input.clientInformation;
    this.tokenValue = input.tokens;

    this.clientMetadata = {
      redirect_uris: [input.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: "Executor v2 MCP Connector",
    };
  }

  get redirectUrl(): string {
    return this.redirectTarget;
  }

  async state(): Promise<string> {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.clientInfo;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    this.clientInfo = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    return this.tokenValue;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.tokenValue = tokens;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrl = authorizationUrl.toString();
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error("Missing PKCE code verifier");
    }

    return this.codeVerifierValue;
  }

  getAuthorizationUrl(): string | undefined {
    return this.authorizationUrl;
  }

  toPending(sourceUrl: string): McpOAuthPending {
    return {
      state: this.stateValue,
      sourceUrl,
      redirectUrl: this.redirectTarget,
      ...(this.codeVerifierValue ? { codeVerifier: this.codeVerifierValue } : {}),
      ...(this.clientInfo ? { clientInformation: this.clientInfo } : {}),
    };
  }

  getTokens(): OAuthTokens | undefined {
    return this.tokenValue;
  }
}

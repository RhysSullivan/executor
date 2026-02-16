import { randomUUID } from "node:crypto";
import { Result } from "better-result";
import { z } from "zod";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

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
  error?: string;
};

const COOKIE_PREFIX = "executor_mcp_oauth_";
export const MCP_OAUTH_RESULT_COOKIE = "executor_mcp_oauth_result";

const versionedPendingSchema = z.object({
  version: z.literal(1),
  pending: z.object({
    state: z.string(),
    sourceUrl: z.string(),
    redirectUrl: z.string(),
    codeVerifier: z.string().optional(),
    clientInformation: z.custom<OAuthClientInformationMixed>().optional(),
  }),
});

const versionedPopupResultSchema = z.object({
  version: z.literal(1),
  result: z.object({
    ok: z.boolean(),
    sourceUrl: z.string().optional(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    scope: z.string().optional(),
    expiresIn: z.number().optional(),
    error: z.string().optional(),
  }),
});

function decodeCookieJson(raw: string): unknown | null {
  const decodedResult = Result.try(() => Buffer.from(raw, "base64url").toString("utf8"));
  if (decodedResult.isErr()) {
    return null;
  }

  const parsedResult = Result.try(() => JSON.parse(decodedResult.value));
  return parsedResult.isOk() ? parsedResult.value : null;
}

export function buildPendingCookieName(state: string): string {
  return `${COOKIE_PREFIX}${state}`;
}

export function createOAuthState(): string {
  return randomUUID();
}

export function encodePendingCookieValue(pending: McpOAuthPending): string {
  return Buffer.from(JSON.stringify({ version: 1, pending }), "utf8").toString("base64url");
}

export function decodePendingCookieValue(raw: string): McpOAuthPending | null {
  const decoded = decodeCookieJson(raw);
  if (!decoded) {
    return null;
  }

  const versionedResult = versionedPendingSchema.safeParse(decoded);
  return versionedResult.success ? versionedResult.data.pending : null;
}

export function encodePopupResultCookieValue(result: McpOAuthPopupResult): string {
  return Buffer.from(JSON.stringify({ version: 1, result }), "utf8").toString("base64url");
}

export function decodePopupResultCookieValue(raw: string): McpOAuthPopupResult | null {
  const decoded = decodeCookieJson(raw);
  if (!decoded) {
    return null;
  }

  const versionedResult = versionedPopupResultSchema.safeParse(decoded);
  return versionedResult.success ? versionedResult.data.result : null;
}

export class McpPopupOAuthProvider implements OAuthClientProvider {
  public clientMetadata: OAuthClientMetadata;
  private stateValue: string;
  private redirectTarget: string;
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
      client_name: "Executor MCP Connector",
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

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
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

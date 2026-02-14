import { randomUUID } from "node:crypto";
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

const COOKIE_PREFIX = "executor_mcp_oauth_";

export function buildPendingCookieName(state: string): string {
  return `${COOKIE_PREFIX}${state}`;
}

export function createOAuthState(): string {
  return randomUUID();
}

export function encodePendingCookieValue(pending: McpOAuthPending): string {
  return Buffer.from(JSON.stringify(pending), "utf8").toString("base64url");
}

export function decodePendingCookieValue(raw: string): McpOAuthPending | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<McpOAuthPending>;
    if (
      typeof parsed.state !== "string"
      || typeof parsed.sourceUrl !== "string"
      || typeof parsed.redirectUrl !== "string"
    ) {
      return null;
    }

    return {
      state: parsed.state,
      sourceUrl: parsed.sourceUrl,
      redirectUrl: parsed.redirectUrl,
      ...(typeof parsed.codeVerifier === "string" ? { codeVerifier: parsed.codeVerifier } : {}),
      ...(parsed.clientInformation ? { clientInformation: parsed.clientInformation } : {}),
    };
  } catch {
    return null;
  }
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

export function oauthPopupResultHtml(payload: {
  ok: boolean;
  sourceUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  scope?: string;
  expiresIn?: number;
  error?: string;
}): string {
  const message = payload.ok
    ? {
        type: "executor:mcp-oauth-result",
        ok: true,
        sourceUrl: payload.sourceUrl,
        payload: {
          accessToken: payload.accessToken,
          ...(payload.refreshToken ? { refreshToken: payload.refreshToken } : {}),
          ...(payload.scope ? { scope: payload.scope } : {}),
          ...(typeof payload.expiresIn === "number" ? { expiresIn: payload.expiresIn } : {}),
        },
      }
    : {
        type: "executor:mcp-oauth-result",
        ok: false,
        error: payload.error ?? "OAuth failed",
      };

  const serialized = JSON.stringify(message);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>MCP OAuth</title>
  </head>
  <body>
    <script>
      (function () {
        const msg = ${serialized};
        try {
          if (window.opener) {
            window.opener.postMessage(msg, window.location.origin);
          }
        } finally {
          window.close();
        }
      })();
    </script>
    <p>You can close this window.</p>
  </body>
</html>`;
}

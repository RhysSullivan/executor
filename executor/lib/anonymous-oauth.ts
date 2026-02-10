/**
 * Self-issued OAuth 2.1 Authorization Server for anonymous MCP clients.
 *
 * This module implements the minimal RFC 8414 / RFC 7591 surface that MCP
 * clients need to complete the standard OAuth flow **without** any external
 * identity provider.  Authenticated (WorkOS) users continue to go through
 * the normal WorkOS authorization server — this module is *only* for
 * anonymous/guest sessions.
 *
 * Flow:
 *   1. Client discovers `/.well-known/oauth-authorization-server`
 *   2. Client dynamically registers via `POST /register` (RFC 7591)
 *   3. Client redirects to `/authorize` — auto-approved, no user interaction
 *   4. Client exchanges code at `POST /token` for a self-signed JWT
 *   5. Client uses JWT as `Authorization: Bearer <token>` on `/mcp`
 *
 * The JWT `sub` claim is a freshly generated anonymous actor ID
 * (`anon_<uuid>`) which the gateway resolves via
 * `bootstrapAnonymousSession` — identical to the existing anonymous flow
 * but now behind a proper Bearer token.
 *
 * Storage is pluggable via the `OAuthStorage` interface:
 * - `InMemoryOAuthStorage` — ephemeral, for tests and single-process dev
 * - `ConvexOAuthStorage` — persists keys & client registrations to Convex,
 *   so tokens survive gateway restarts
 *
 * Authorization codes are always in-memory (short-lived, single-use).
 */

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
  type CryptoKey as JoseCryptoKey,
} from "jose";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnonOAuthClientRegistration {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
}

interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  actorId: string;
  expiresAt: number;
}

export interface AnonOAuthConfig {
  /** The public issuer URL (origin of the gateway). */
  issuer: string;
  /** Access token TTL in seconds. Default 24 h. */
  accessTokenTtlSeconds?: number;
  /** Authorization code TTL in seconds. Default 120 s. */
  codeExpirySeconds?: number;
  /** Pluggable storage backend for keys & client registrations. */
  storage?: OAuthStorage;
}

// ---------------------------------------------------------------------------
// Storage interface
// ---------------------------------------------------------------------------

export interface StoredSigningKey {
  keyId: string;
  algorithm: string;
  privateKeyJwk: JWK;
  publicKeyJwk: JWK;
}

export interface OAuthStorage {
  /**
   * Load the active signing key pair.
   * Returns null if no key has been generated yet.
   */
  getActiveSigningKey(): Promise<StoredSigningKey | null>;

  /**
   * Store a new signing key pair (rotating any previous active key).
   */
  storeSigningKey(key: StoredSigningKey): Promise<void>;

  /**
   * Register a new OAuth client. Returns the registration.
   */
  registerClient(registration: AnonOAuthClientRegistration): Promise<AnonOAuthClientRegistration>;

  /**
   * Look up an OAuth client by client_id. Returns null if not found.
   */
  getClient(clientId: string): Promise<AnonOAuthClientRegistration | null>;
}

// ---------------------------------------------------------------------------
// In-memory storage (for tests and single-process dev)
// ---------------------------------------------------------------------------

export class InMemoryOAuthStorage implements OAuthStorage {
  private signingKey: StoredSigningKey | null = null;
  private readonly clients = new Map<string, AnonOAuthClientRegistration>();

  async getActiveSigningKey(): Promise<StoredSigningKey | null> {
    return this.signingKey;
  }

  async storeSigningKey(key: StoredSigningKey): Promise<void> {
    this.signingKey = key;
  }

  async registerClient(registration: AnonOAuthClientRegistration): Promise<AnonOAuthClientRegistration> {
    this.clients.set(registration.client_id, registration);
    return registration;
  }

  async getClient(clientId: string): Promise<AnonOAuthClientRegistration | null> {
    return this.clients.get(clientId) ?? null;
  }

  /** Test helper: number of registered clients. */
  get clientCount(): number {
    return this.clients.size;
  }
}

// ---------------------------------------------------------------------------
// Anonymous OAuth Server
// ---------------------------------------------------------------------------

export class AnonymousOAuthServer {
  private readonly issuer: string;
  private readonly accessTokenTtlSeconds: number;
  private readonly codeExpirySeconds: number;
  private readonly storage: OAuthStorage;

  private privateKey!: JoseCryptoKey;
  private publicJwk!: JWK;
  private keyId!: string;

  /** In-memory authorization codes (short-lived, cleaned up on use). */
  private readonly codes = new Map<string, AuthorizationCode>();

  constructor(config: AnonOAuthConfig) {
    this.issuer = config.issuer.replace(/\/+$/, "");
    this.accessTokenTtlSeconds = config.accessTokenTtlSeconds ?? 24 * 60 * 60;
    this.codeExpirySeconds = config.codeExpirySeconds ?? 120;
    this.storage = config.storage ?? new InMemoryOAuthStorage();
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize the OAuth server.
   *
   * Attempts to load an existing signing key from storage. If none exists,
   * generates a new RSA key pair and persists it. Either way, the private
   * key and public JWK are cached locally for fast in-process operations.
   */
  async init(): Promise<void> {
    const existing = await this.storage.getActiveSigningKey();

    if (existing) {
      // Import the persisted key pair into CryptoKey objects
      this.keyId = existing.keyId;
      this.publicJwk = { ...existing.publicKeyJwk, kid: this.keyId, use: "sig", alg: existing.algorithm };
      this.privateKey = await importJWK(existing.privateKeyJwk, existing.algorithm) as JoseCryptoKey;
      return;
    }

    // No existing key — generate a fresh pair and persist it
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    this.privateKey = privateKey;
    this.keyId = `anon_key_${crypto.randomUUID().slice(0, 8)}`;

    const publicJwk = await exportJWK(publicKey);
    this.publicJwk = { ...publicJwk, kid: this.keyId, use: "sig", alg: "RS256" };

    const privateKeyJwk = await exportJWK(privateKey);

    await this.storage.storeSigningKey({
      keyId: this.keyId,
      algorithm: "RS256",
      privateKeyJwk,
      publicKeyJwk: publicJwk,
    });
  }

  /** Import an existing key pair (for tests or manual persistence). */
  async initWithKeys(privateKey: JoseCryptoKey, publicJwk: JWK): Promise<void> {
    this.privateKey = privateKey;
    this.keyId = publicJwk.kid ?? `anon_key_${crypto.randomUUID().slice(0, 8)}`;
    this.publicJwk = { ...publicJwk, kid: this.keyId, use: "sig", alg: "RS256" };
  }

  // -------------------------------------------------------------------------
  // RFC 8414 — Authorization Server Metadata
  // -------------------------------------------------------------------------

  getMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      jwks_uri: `${this.issuer}/oauth2/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [],
    };
  }

  // -------------------------------------------------------------------------
  // JWKS
  // -------------------------------------------------------------------------

  getJwks(): { keys: JWK[] } {
    return { keys: [this.publicJwk] };
  }

  // -------------------------------------------------------------------------
  // RFC 7591 — Dynamic Client Registration
  // -------------------------------------------------------------------------

  async registerClient(body: {
    redirect_uris?: string[];
    client_name?: string;
  }): Promise<AnonOAuthClientRegistration> {
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new OAuthBadRequest("redirect_uris is required and must be non-empty");
    }

    for (const uri of redirectUris) {
      if (typeof uri !== "string" || uri.length === 0) {
        throw new OAuthBadRequest("Each redirect_uri must be a non-empty string");
      }
    }

    const clientId = `anon_client_${crypto.randomUUID()}`;
    const registration: AnonOAuthClientRegistration = {
      client_id: clientId,
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      redirect_uris: redirectUris,
      created_at: Date.now(),
    };

    return await this.storage.registerClient(registration);
  }

  // -------------------------------------------------------------------------
  // Authorization endpoint
  // -------------------------------------------------------------------------

  /**
   * Handle `GET /authorize`.  Because this is anonymous-only, there is no
   * user to authenticate — we auto-approve and redirect back immediately
   * with an authorization code.
   */
  async authorize(params: URLSearchParams): Promise<{ redirectTo: string }> {
    const responseType = params.get("response_type");
    if (responseType !== "code") {
      throw new OAuthBadRequest("response_type must be 'code'");
    }

    const clientId = params.get("client_id");
    if (!clientId) {
      throw new OAuthBadRequest("client_id is required");
    }

    const client = await this.storage.getClient(clientId);
    if (!client) {
      throw new OAuthBadRequest("Unknown client_id");
    }

    const redirectUri = params.get("redirect_uri");
    if (!redirectUri) {
      throw new OAuthBadRequest("redirect_uri is required");
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      throw new OAuthBadRequest("redirect_uri does not match registered URIs");
    }

    const codeChallenge = params.get("code_challenge");
    const codeChallengeMethod = params.get("code_challenge_method");
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      throw new OAuthBadRequest("PKCE S256 code_challenge is required");
    }

    // Generate anonymous identity
    const actorId = `anon_${crypto.randomUUID()}`;

    // Issue authorization code (always in-memory — short-lived, single-use)
    const code = crypto.randomUUID();
    this.codes.set(code, {
      code,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      actorId,
      expiresAt: Date.now() + this.codeExpirySeconds * 1000,
    });

    // Build redirect URL
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    const state = params.get("state");
    if (state) {
      redirect.searchParams.set("state", state);
    }

    return { redirectTo: redirect.toString() };
  }

  // -------------------------------------------------------------------------
  // Token endpoint
  // -------------------------------------------------------------------------

  /**
   * Handle `POST /token`.  Exchange authorization code + PKCE verifier for
   * a self-signed JWT access token.
   */
  async exchangeToken(body: URLSearchParams): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
  }> {
    const grantType = body.get("grant_type");
    if (grantType !== "authorization_code") {
      throw new OAuthBadRequest("grant_type must be authorization_code");
    }

    const codeValue = body.get("code");
    if (!codeValue) {
      throw new OAuthBadRequest("code is required");
    }

    const storedCode = this.codes.get(codeValue);
    if (!storedCode) {
      throw new OAuthBadRequest("invalid or expired code");
    }

    // Consume the code immediately (one-time use)
    this.codes.delete(codeValue);

    if (Date.now() > storedCode.expiresAt) {
      throw new OAuthBadRequest("authorization code has expired");
    }

    // Verify redirect_uri matches
    const redirectUri = body.get("redirect_uri");
    if (redirectUri !== storedCode.redirectUri) {
      throw new OAuthBadRequest("redirect_uri mismatch");
    }

    // Verify PKCE
    const codeVerifier = body.get("code_verifier");
    if (!codeVerifier) {
      throw new OAuthBadRequest("code_verifier is required");
    }

    const expectedChallenge = await computeS256Challenge(codeVerifier);
    if (expectedChallenge !== storedCode.codeChallenge) {
      throw new OAuthBadRequest("code_verifier does not match code_challenge");
    }

    // Mint JWT
    const accessToken = await new SignJWT({
      sub: storedCode.actorId,
      provider: "anonymous",
    })
      .setProtectedHeader({ alg: "RS256", kid: this.keyId })
      .setIssuer(this.issuer)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTokenTtlSeconds}s`)
      .setJti(crypto.randomUUID())
      .sign(this.privateKey);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSeconds,
    };
  }

  // -------------------------------------------------------------------------
  // Token verification (used by the gateway to verify self-issued tokens)
  // -------------------------------------------------------------------------

  async verifyToken(
    token: string,
  ): Promise<{ sub: string; provider: string } | null> {
    try {
      const jwks = createLocalJWKSet({ keys: [this.publicJwk] });
      const { payload } = await jwtVerify(token, jwks, {
        issuer: this.issuer,
      });

      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        return null;
      }

      return {
        sub: payload.sub,
        provider: typeof payload.provider === "string" ? payload.provider : "anonymous",
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Accessors (for integration)
  // -------------------------------------------------------------------------

  getIssuer(): string {
    return this.issuer;
  }

  getCodeCount(): number {
    return this.codes.size;
  }

  /** Purge expired authorization codes (call periodically). */
  purgeExpiredCodes(): number {
    const now = Date.now();
    let purged = 0;
    for (const [key, code] of this.codes) {
      if (now > code.expiresAt) {
        this.codes.delete(key);
        purged++;
      }
    }
    return purged;
  }
}

// ---------------------------------------------------------------------------
// PKCE S256 helper
// ---------------------------------------------------------------------------

export async function computeS256Challenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class OAuthBadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthBadRequest";
  }
}

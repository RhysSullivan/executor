import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type {
  AnonOAuthClientRegistration,
  OAuthStorage,
  StoredSigningKey,
} from "../../core/src/anonymous-oauth";

export class ActionOAuthStorage implements OAuthStorage {
  constructor(private readonly ctx: ActionCtx) {}

  async getActiveSigningKey(): Promise<StoredSigningKey | null> {
    const result = await this.ctx.runQuery(
      internal.database.getActiveAnonymousOauthSigningKey,
      {},
    );

    if (!result) return null;

    return {
      keyId: result.keyId,
      algorithm: result.algorithm,
      privateKeyJwk: result.privateKeyJwk,
      publicKeyJwk: result.publicKeyJwk,
    };
  }

  async storeSigningKey(key: StoredSigningKey): Promise<void> {
    await this.ctx.runMutation(
      internal.database.storeAnonymousOauthSigningKey,
      {
        keyId: key.keyId,
        algorithm: key.algorithm,
        privateKeyJwk: key.privateKeyJwk,
        publicKeyJwk: key.publicKeyJwk,
      },
    );
  }

  async registerClient(
    registration: AnonOAuthClientRegistration,
  ): Promise<AnonOAuthClientRegistration> {
    const result = await this.ctx.runMutation(
      internal.database.registerAnonymousOauthClient,
      {
        clientId: registration.client_id,
        clientName: registration.client_name,
        redirectUris: registration.redirect_uris,
      },
    );

    return {
      client_id: result.client_id,
      client_name: result.client_name ?? undefined,
      redirect_uris: result.redirect_uris,
      created_at: result.created_at,
    };
  }

  async getClient(clientId: string): Promise<AnonOAuthClientRegistration | null> {
    const result = await this.ctx.runQuery(
      internal.database.getAnonymousOauthClient,
      { clientId },
    );

    if (!result) return null;

    return {
      client_id: result.client_id,
      client_name: result.client_name ?? undefined,
      redirect_uris: result.redirect_uris,
      created_at: result.created_at,
    };
  }

  async storeAuthorizationCode(code: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    actorId: string;
    tokenClaims?: Record<string, unknown>;
    expiresAt: number;
    createdAt: number;
  }): Promise<void> {
    await this.ctx.runMutation(internal.database.storeAnonymousOauthAuthorizationCode, {
      ...code,
    });
  }

  async consumeAuthorizationCode(code: string): Promise<{
    code: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    actorId: string;
    tokenClaims?: Record<string, unknown>;
    expiresAt: number;
    createdAt: number;
  } | null> {
    const result = await this.ctx.runMutation(internal.database.consumeAnonymousOauthAuthorizationCode, {
      code,
    });

    if (!result) {
      return null;
    }

    return {
      code: result.code,
      clientId: result.clientId,
      redirectUri: result.redirectUri,
      codeChallenge: result.codeChallenge,
      codeChallengeMethod: result.codeChallengeMethod,
      actorId: result.actorId,
      tokenClaims: result.tokenClaims ?? undefined,
      expiresAt: result.expiresAt,
      createdAt: result.createdAt,
    };
  }

  async purgeExpiredAuthorizationCodes(now: number): Promise<number> {
    const result = await this.ctx.runMutation(internal.database.purgeExpiredAnonymousOauthAuthorizationCodes, {
      now,
    });
    return result.purged;
  }

  async countAuthorizationCodes(): Promise<number> {
    const result = await this.ctx.runQuery(internal.database.countAnonymousOauthAuthorizationCodes, {
    });
    return result.count;
  }
}

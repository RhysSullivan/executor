/**
 * Convex-backed storage for the anonymous OAuth server.
 *
 * Persists signing keys and client registrations to Convex so they
 * survive gateway restarts. Keys are cached locally after first load
 * for fast in-process token verification.
 *
 * All Convex calls include an `internalSecret` argument that is validated
 * server-side against `EXECUTOR_INTERNAL_TOKEN`, preventing unauthorized
 * access to private key material.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type {
  OAuthStorage,
  StoredSigningKey,
  AnonOAuthClientRegistration,
} from "./anonymous-oauth";

export class ConvexOAuthStorage implements OAuthStorage {
  private readonly convex: ConvexHttpClient;
  private readonly internalSecret: string;

  constructor(convexUrl: string, internalSecret: string) {
    if (!internalSecret) {
      throw new Error(
        "ConvexOAuthStorage requires an internalSecret (EXECUTOR_INTERNAL_TOKEN)",
      );
    }
    this.convex = new ConvexHttpClient(convexUrl);
    this.internalSecret = internalSecret;
  }

  async getActiveSigningKey(): Promise<StoredSigningKey | null> {
    const result = await this.convex.query(
      api.anonymousOauth.getActiveSigningKey,
      { internalSecret: this.internalSecret },
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
    await this.convex.mutation(
      api.anonymousOauth.storeSigningKey,
      {
        internalSecret: this.internalSecret,
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
    const result = await this.convex.mutation(
      api.anonymousOauth.registerClient,
      {
        internalSecret: this.internalSecret,
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
    const result = await this.convex.query(
      api.anonymousOauth.getClient,
      { internalSecret: this.internalSecret, clientId },
    );

    if (!result) return null;

    return {
      client_id: result.client_id,
      client_name: result.client_name ?? undefined,
      redirect_uris: result.redirect_uris,
      created_at: result.created_at,
    };
  }
}

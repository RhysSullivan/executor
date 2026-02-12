/**
 * Public Convex functions for the self-issued anonymous OAuth server.
 *
 * These are called by the MCP gateway process (via ConvexHttpClient) to
 * persist signing keys and client registrations across restarts.
 *
 * All functions require an `internalSecret` argument that must match the
 * `EXECUTOR_INTERNAL_TOKEN` environment variable.  This prevents arbitrary
 * callers from reading private key material or injecting signing keys.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";

function requireInternalSecret(secret: string): void {
  const expected = process.env.EXECUTOR_INTERNAL_TOKEN;
  if (!expected) {
    throw new Error("EXECUTOR_INTERNAL_TOKEN is not configured");
  }
  if (secret !== expected) {
    throw new Error("Unauthorized: invalid internal secret");
  }
}

// ── Signing Keys ────────────────────────────────────────────────────────────

export const getActiveSigningKey = query({
  args: { internalSecret: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.runQuery(
      internal.database.getActiveAnonymousOauthSigningKey,
      {},
    );
  },
});

export const storeSigningKey = mutation({
  args: {
    internalSecret: v.string(),
    keyId: v.string(),
    algorithm: v.string(),
    privateKeyJwk: v.any(),
    publicKeyJwk: v.any(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const { internalSecret: _, ...keyArgs } = args;
    return await ctx.runMutation(
      internal.database.storeAnonymousOauthSigningKey,
      keyArgs,
    );
  },
});

// ── Client Registrations ────────────────────────────────────────────────────

export const registerClient = mutation({
  args: {
    internalSecret: v.string(),
    clientId: v.string(),
    clientName: v.optional(v.string()),
    redirectUris: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const { internalSecret: _, ...clientArgs } = args;
    return await ctx.runMutation(
      internal.database.registerAnonymousOauthClient,
      clientArgs,
    );
  },
});

export const getClient = query({
  args: { internalSecret: v.string(), clientId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.runQuery(
      internal.database.getAnonymousOauthClient,
      { clientId: args.clientId },
    );
  },
});

// ── Authorization Codes ─────────────────────────────────────────────────────

export const storeAuthorizationCode = mutation({
  args: {
    internalSecret: v.string(),
    code: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.string(),
    actorId: v.string(),
    tokenClaims: v.optional(v.any()),
    expiresAt: v.number(),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const { internalSecret: _, ...payload } = args;
    await ctx.runMutation(internal.database.storeAnonymousOauthAuthorizationCode, payload);
  },
});

export const consumeAuthorizationCode = mutation({
  args: {
    internalSecret: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.runMutation(internal.database.consumeAnonymousOauthAuthorizationCode, {
      code: args.code,
    });
  },
});

export const purgeExpiredAuthorizationCodes = mutation({
  args: {
    internalSecret: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.runMutation(internal.database.purgeExpiredAnonymousOauthAuthorizationCodes, {
      now: args.now,
    });
  },
});

export const countAuthorizationCodes = query({
  args: {
    internalSecret: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.runQuery(internal.database.countAnonymousOauthAuthorizationCodes, {});
  },
});

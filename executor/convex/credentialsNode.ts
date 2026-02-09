"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";

const credentialScopeValidator = v.union(v.literal("workspace"), v.literal("actor"));
const credentialProviderValidator = v.union(v.literal("managed"), v.literal("workos-vault"));

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizedActorId(scope: "workspace" | "actor", actorId?: string): string {
  if (scope !== "actor") return "";
  if (typeof actorId !== "string") return "";
  return actorId.trim();
}

function extractObjectId(secretJson: Record<string, unknown>): string | null {
  const candidate =
    (typeof secretJson.objectId === "string" ? secretJson.objectId : "") ||
    (typeof secretJson.id === "string" ? secretJson.id : "");
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripObjectRef(secretJson: Record<string, unknown>): Record<string, unknown> {
  const { objectId: _objectId, id: _id, ...rest } = secretJson;
  return asRecord(rest);
}

function hasPayload(secretJson: Record<string, unknown>): boolean {
  return Object.keys(stripObjectRef(secretJson)).length > 0;
}

function buildVaultObjectName(args: {
  workspaceId: string;
  sourceKey: string;
  scope: "workspace" | "actor";
  actorId: string;
}): string {
  const actorSegment = args.scope === "actor" ? args.actorId || "actor" : "workspace";
  const sourceSegment = args.sourceKey
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return `executor-cred-${args.workspaceId.slice(0, 24)}-${sourceSegment}-${actorSegment.slice(0, 24)}-${crypto.randomUUID().slice(0, 8)}`;
}

function workosClient(): WorkOS {
  const key = process.env.WORKOS_API_KEY?.trim();
  if (!key) {
    throw new Error("Encrypted storage requires WORKOS_API_KEY");
  }
  return new WorkOS(key);
}

function isRetryableVaultError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("not yet ready") ||
    message.includes("can be retried") ||
    (message.includes("kek") && message.includes("ready"))
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withVaultRetry<T>(operation: () => Promise<T>): Promise<T> {
  const maxAttempts = 10;
  const maxDelayMs = 10_000;
  let delayMs = 500;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableVaultError(error)) {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw new Error(
          "Encrypted storage is still initializing in WorkOS. Please wait about 60 seconds and retry.",
        );
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }

  throw new Error("Unreachable retry state");
}

async function upsertVaultObject(args: {
  workspaceId: string;
  sourceKey: string;
  scope: "workspace" | "actor";
  actorId: string;
  existingObjectId: string | null;
  payload: Record<string, unknown>;
}): Promise<string> {
  const workos = workosClient();
  const value = JSON.stringify(args.payload);

  if (args.existingObjectId) {
    const objectId: string = args.existingObjectId;
    const updated = await withVaultRetry(async () => {
      return await workos.vault.updateObject({
        id: objectId,
        value,
      });
    });
    return updated.id;
  }

  const created = await withVaultRetry(async () => {
    return await workos.vault.createObject({
      name: buildVaultObjectName(args),
      value,
      context: {
        workspace_id: args.workspaceId,
      },
    });
  });

  return created.id;
}

export const upsertCredential = action({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.string(),
    sessionId: v.optional(v.string()),
    sourceKey: v.string(),
    scope: credentialScopeValidator,
    actorId: v.optional(v.string()),
    provider: v.optional(credentialProviderValidator),
    secretJson: v.any(),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
    });
    const canonicalActorId = access.provider === "anonymous"
      ? access.providerAccountId
      : access.accountId;

    if (args.scope === "actor" && args.actorId && args.actorId !== canonicalActorId) {
      throw new Error("actorId must match the authenticated workspace actor");
    }

    const provider = args.provider ?? "managed";
    const actorId = normalizedActorId(args.scope, args.actorId ?? canonicalActorId);
    const submittedSecret = asRecord(args.secretJson);

    if (provider === "managed") {
      return await ctx.runMutation(internal.database.upsertCredential, {
        id: args.id,
        workspaceId: args.workspaceId,
        sourceKey: args.sourceKey,
        scope: args.scope,
        actorId,
        provider,
        secretJson: submittedSecret,
      });
    }

    const submittedObjectId = extractObjectId(submittedSecret);
    if (submittedObjectId && /^gh[opu]_/.test(submittedObjectId)) {
      throw new Error("Encrypted storage value looks like a GitHub token. Paste the token in the token field.");
    }

    const existing: Record<string, unknown> | null = await ctx.runQuery(internal.database.resolveCredential, {
      workspaceId: args.workspaceId,
      sourceKey: args.sourceKey,
      scope: args.scope,
      ...(args.scope === "actor" ? { actorId } : {}),
    });
    const existingObjectId: string | null = existing ? extractObjectId(asRecord(existing.secretJson)) : null;

    const objectId = (() => {
      if (submittedObjectId) return submittedObjectId;
      return null;
    })();

    let finalObjectId = objectId;
    if (!finalObjectId && hasPayload(submittedSecret)) {
      finalObjectId = await upsertVaultObject({
        workspaceId: args.workspaceId,
        sourceKey: args.sourceKey,
        scope: args.scope,
        actorId,
        existingObjectId,
        payload: stripObjectRef(submittedSecret),
      });
    }

    if (!finalObjectId && existingObjectId) {
      finalObjectId = existingObjectId;
    }

    if (!finalObjectId) {
      throw new Error("Encrypted storage requires credential values");
    }

    return await ctx.runMutation(internal.database.upsertCredential, {
      id: args.id,
      workspaceId: args.workspaceId,
      sourceKey: args.sourceKey,
      scope: args.scope,
      ...(args.scope === "actor" ? { actorId } : {}),
      provider,
      secretJson: { objectId: finalObjectId },
    });
  },
});

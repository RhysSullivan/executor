import { WorkOS } from "@workos-inc/node";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import type { ActionCtx } from "../../convex/_generated/server";
import {
  assertMatchesCanonicalActorId,
  canonicalActorIdForWorkspaceAccess,
} from "../auth/actor_identity";
import { asRecord } from "../lib/object";

type Internal = typeof import("../../convex/_generated/api").internal;

type SecretBackend = "local-convex" | "workos-vault";

function normalizedActorId(scope: "workspace" | "actor", actorId?: string): string {
  if (scope !== "actor") return "";
  if (typeof actorId !== "string") return "";
  return actorId.trim();
}

function configuredSecretBackend(): SecretBackend {
  const explicit = process.env.EXECUTOR_SECRET_BACKEND?.trim().toLowerCase();
  if (explicit === "workos" || explicit === "workos-vault") {
    return "workos-vault";
  }
  if (explicit === "local" || explicit === "local-convex") {
    return "local-convex";
  }
  return process.env.WORKOS_API_KEY?.trim() ? "workos-vault" : "local-convex";
}

function extractObjectId(secretJson: Record<string, unknown>): string | null {
  const candidate =
    (typeof secretJson.objectId === "string" ? secretJson.objectId : "") ||
    (typeof secretJson.id === "string" ? secretJson.id : "");
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractHeaderOverrides(secretJson: Record<string, unknown>): {
  cleanSecret: Record<string, unknown>;
  overridesJson: Record<string, unknown>;
} {
  const rawHeaders = asRecord(secretJson.__headers);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (!name) continue;
    const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
    if (!text) continue;
    headers[name.trim()] = text;
  }

  const { __headers: _headers, ...rest } = secretJson;
  return {
    cleanSecret: asRecord(rest),
    overridesJson: Object.keys(headers).length > 0 ? { headers } : {},
  };
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

  return `executor-conn-${args.workspaceId.slice(0, 24)}-${sourceSegment}-${actorSegment.slice(0, 24)}-${crypto.randomUUID().slice(0, 8)}`;
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

export async function upsertCredentialHandler(
  ctx: ActionCtx,
  internal: Internal,
  args: {
    id?: string;
    workspaceId: Id<"workspaces">;
    sessionId?: string;
    sourceKey: string;
    scope: "workspace" | "actor";
    actorId?: string;
    provider?: "local-convex" | "workos-vault";
    secretJson: unknown;
  },
): Promise<Record<string, unknown>> {
  const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
  });
  const canonicalActorId = canonicalActorIdForWorkspaceAccess(access);
  if (args.scope === "actor") {
    assertMatchesCanonicalActorId(args.actorId, canonicalActorId);
  }

  const actorId = normalizedActorId(args.scope, args.actorId ?? canonicalActorId);
  const rawSubmittedSecret = asRecord(args.secretJson);
  const { cleanSecret: submittedSecret, overridesJson } = extractHeaderOverrides(rawSubmittedSecret);

  const existingBinding = await ctx.runQuery(internal.database.resolveCredential, {
    workspaceId: args.workspaceId,
    sourceKey: args.sourceKey,
    scope: args.scope,
    ...(args.scope === "actor" ? { actorId } : {}),
  });

  const allCredentials: Array<Record<string, unknown>> = await ctx.runQuery(internal.database.listCredentials, {
    workspaceId: args.workspaceId,
  });
  const requestedId = args.id?.trim();
  const existingConnection = requestedId
    ? allCredentials.find((credential) => {
      const id = String(credential.id ?? "");
      const bindingId = String(credential.bindingId ?? "");
      if (id !== requestedId && bindingId !== requestedId) return false;
      if (String(credential.scope ?? "") !== args.scope) return false;
      if (args.scope === "actor") {
        return String(credential.actorId ?? "") === actorId;
      }
      return true;
    }) ?? allCredentials.find((credential) => {
      const id = String(credential.id ?? "");
      const bindingId = String(credential.bindingId ?? "");
      return id === requestedId || bindingId === requestedId;
    })
    : null;
  const connectionId = String(existingConnection?.id ?? requestedId ?? "").trim() || undefined;

  const backend = configuredSecretBackend();

  if (backend === "local-convex") {
    const finalSecret = Object.keys(submittedSecret).length > 0
      ? submittedSecret
      : asRecord(existingConnection?.secretJson ?? existingBinding?.secretJson);
    if (Object.keys(finalSecret).length === 0) {
      throw new Error("Credential values are required");
    }

    return await ctx.runMutation(internal.database.upsertCredential, {
      id: connectionId,
      workspaceId: args.workspaceId,
      sourceKey: args.sourceKey,
      scope: args.scope,
      ...(args.scope === "actor" ? { actorId } : {}),
      provider: "local-convex",
      secretJson: finalSecret,
      overridesJson,
    });
  }

  const submittedObjectId = extractObjectId(submittedSecret);
  if (submittedObjectId && /^gh[opu]_/.test(submittedObjectId)) {
    throw new Error("Encrypted storage value looks like a GitHub token. Paste the token in the token field.");
  }

  const existingObjectId = extractObjectId(
    asRecord(existingConnection?.secretJson ?? existingBinding?.secretJson),
  );

  let finalObjectId = submittedObjectId;
  if (!finalObjectId && Object.keys(submittedSecret).length > 0) {
    finalObjectId = await upsertVaultObject({
      workspaceId: args.workspaceId,
      sourceKey: args.sourceKey,
      scope: args.scope,
      actorId,
      existingObjectId,
      payload: submittedSecret,
    });
  }

  if (!finalObjectId && existingObjectId) {
    finalObjectId = existingObjectId;
  }

  if (!finalObjectId) {
    throw new Error("Credential values are required");
  }

  return await ctx.runMutation(internal.database.upsertCredential, {
    id: connectionId,
    workspaceId: args.workspaceId,
    sourceKey: args.sourceKey,
    scope: args.scope,
    ...(args.scope === "actor" ? { actorId } : {}),
    provider: "workos-vault",
    secretJson: { objectId: finalObjectId },
    overridesJson,
  });
}

import { Result } from "better-result";
import { z } from "zod";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import type { ActionCtx } from "../../convex/_generated/server";
import {
  createWorkosClient,
  extractWorkosVaultObjectId,
  withWorkosVaultRetryResult,
} from "../../../core/src/credentials/workos-vault";
import { normalizeCredentialAdditionalHeaders } from "../../../core/src/tool/source-auth";

type Internal = typeof import("../../convex/_generated/api").internal;

type SecretBackend = "local-convex" | "workos-vault";

const recordSchema = z.record(z.unknown());

const listedCredentialSchema = z.object({
  id: z.string().optional(),
  bindingId: z.string().optional(),
  scopeType: z.enum(["account", "organization", "workspace"]).optional(),
  accountId: z.string().optional(),
  secretJson: z.record(z.unknown()).optional(),
});

type ListedCredential = z.infer<typeof listedCredentialSchema>;

function toRecordValue(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function normalizedAccountId(scopeType: "account" | "organization" | "workspace", accountId?: string): string {
  if (scopeType !== "account") return "";
  if (typeof accountId !== "string") return "";
  return accountId.trim();
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

function parseListedCredentials(value: unknown): ListedCredential[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const parsed = listedCredentialSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function buildVaultObjectName(args: {
  workspaceId: string;
  sourceKey: string;
  scopeType: "account" | "organization" | "workspace";
  accountId: string;
}): string {
  const scopeSegment = args.scopeType === "account"
    ? args.accountId || "account"
    : args.scopeType;
  const sourceSegment = args.sourceKey
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return `executor-conn-${args.workspaceId.slice(0, 24)}-${sourceSegment}-${scopeSegment.slice(0, 24)}-${crypto.randomUUID().slice(0, 8)}`;
}

async function upsertVaultObject(args: {
  workspaceId: string;
  sourceKey: string;
  scopeType: "account" | "organization" | "workspace";
  accountId: string;
  existingObjectId: string | null;
  payload: Record<string, unknown>;
}): Promise<Result<string, Error>> {
  const workosResult = createWorkosClient();
  if (workosResult.isErr()) {
    return Result.err(workosResult.error);
  }

  const workos = workosResult.value;
  const value = JSON.stringify(args.payload);

  if (args.existingObjectId) {
    const objectId = args.existingObjectId;
    const updatedResult = await withWorkosVaultRetryResult(async () => {
      return await workos.vault.updateObject({
        id: objectId,
        value,
      });
    }, {
      maxAttempts: 10,
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      exhaustionErrorMessage: "Encrypted storage is still initializing in WorkOS. Please wait about 60 seconds and retry.",
    });
    if (updatedResult.isErr()) {
      return Result.err(updatedResult.error);
    }

    return Result.ok(updatedResult.value.id);
  }

  const createdResult = await withWorkosVaultRetryResult(async () => {
    return await workos.vault.createObject({
      name: buildVaultObjectName(args),
      value,
      context: {
        workspace_id: args.workspaceId,
      },
    });
  }, {
    maxAttempts: 10,
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    exhaustionErrorMessage: "Encrypted storage is still initializing in WorkOS. Please wait about 60 seconds and retry.",
  });
  if (createdResult.isErr()) {
    return Result.err(createdResult.error);
  }

  return Result.ok(createdResult.value.id);
}

export async function upsertCredentialHandler(
  ctx: ActionCtx & {
    workspaceId: Id<"workspaces">;
    accountId: Id<"accounts">;
  },
  internal: Internal,
  args: {
    id?: string;
    scopeType?: "account" | "organization" | "workspace";
    sourceKey: string;
    accountId?: Id<"accounts">;
    provider?: "local-convex" | "workos-vault";
    secretJson: unknown;
    additionalHeaders?: unknown;
  },
): Promise<Record<string, unknown>> {
  const scopeType = args.scopeType ?? "workspace";
  if (scopeType === "account" && args.accountId && args.accountId !== ctx.accountId) {
    throw new Error("accountId must match the authenticated account for account-scoped credentials");
  }
  const accountId = normalizedAccountId(scopeType, args.accountId ?? ctx.accountId);
  const submittedSecret = toRecordValue(args.secretJson);
  const hasAdditionalHeaders = args.additionalHeaders !== undefined;
  const additionalHeaders = hasAdditionalHeaders
    ? normalizeCredentialAdditionalHeaders(args.additionalHeaders)
    : undefined;

  const existingBinding = await ctx.runQuery(internal.database.resolveCredential, {
    workspaceId: ctx.workspaceId,
    sourceKey: args.sourceKey,
    scopeType,
    accountId: scopeType === "account" ? (accountId as Id<"accounts">) : undefined,
  });

  const allCredentialsRaw = await ctx.runQuery(internal.database.listCredentials, {
    workspaceId: ctx.workspaceId,
    accountId: ctx.accountId,
  });
  const allCredentials = parseListedCredentials(allCredentialsRaw);
  const requestedId = args.id?.trim();
  const existingConnection = requestedId
    ? allCredentials.find((credential) => {
      const id = (credential.id ?? "").trim();
      const bindingId = (credential.bindingId ?? "").trim();
      if (id !== requestedId && bindingId !== requestedId) return false;
      if ((credential.scopeType ?? "workspace") !== scopeType) return false;
      if (scopeType === "account") {
        return (credential.accountId ?? "").trim() === accountId;
      }
      return true;
    }) ?? allCredentials.find((credential) => {
      const id = (credential.id ?? "").trim();
      const bindingId = (credential.bindingId ?? "").trim();
      return id === requestedId || bindingId === requestedId;
    })
    : null;
  const connectionId = (existingConnection?.id ?? requestedId ?? "").trim() || undefined;

  const backend = configuredSecretBackend();

  if (backend === "local-convex") {
    const finalSecret = Object.keys(submittedSecret).length > 0
      ? submittedSecret
      : toRecordValue(existingConnection?.secretJson ?? existingBinding?.secretJson);
    if (Object.keys(finalSecret).length === 0) {
      throw new Error("Credential values are required");
    }

    return await ctx.runMutation(internal.database.upsertCredential, {
      id: connectionId,
      workspaceId: ctx.workspaceId,
      scopeType,
      sourceKey: args.sourceKey,
      accountId: scopeType === "account" ? (accountId as Id<"accounts">) : undefined,
      provider: "local-convex",
      secretJson: finalSecret,
      ...(hasAdditionalHeaders ? { additionalHeaders } : {}),
    });
  }

  const submittedObjectId = extractWorkosVaultObjectId(submittedSecret);
  if (submittedObjectId && /^gh[opu]_/.test(submittedObjectId)) {
    throw new Error("Encrypted storage value looks like a GitHub token. Paste the token in the token field.");
  }

  const existingObjectId = extractWorkosVaultObjectId(
    toRecordValue(existingConnection?.secretJson ?? existingBinding?.secretJson),
  );

  let finalObjectId = submittedObjectId;
  if (!finalObjectId && Object.keys(submittedSecret).length > 0) {
    const upsertResult = await upsertVaultObject({
      workspaceId: ctx.workspaceId,
      sourceKey: args.sourceKey,
      scopeType,
      accountId,
      existingObjectId,
      payload: submittedSecret,
    });
    if (upsertResult.isErr()) {
      throw upsertResult.error;
    }
    finalObjectId = upsertResult.value;
  }

  if (!finalObjectId && existingObjectId) {
    finalObjectId = existingObjectId;
  }

  if (!finalObjectId) {
    throw new Error("Credential values are required");
  }

  return await ctx.runMutation(internal.database.upsertCredential, {
    id: connectionId,
    workspaceId: ctx.workspaceId,
    scopeType,
    sourceKey: args.sourceKey,
    accountId: scopeType === "account" ? (accountId as Id<"accounts">) : undefined,
    provider: "workos-vault",
    secretJson: { objectId: finalObjectId },
    ...(hasAdditionalHeaders ? { additionalHeaders } : {}),
  });
}

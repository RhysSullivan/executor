"use node";

import { Result } from "better-result";
import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { resolveCredentialPayload } from "../../../core/src/credential-providers";
import type { ResolvedToolCredential, TaskRecord, ToolCallRecord, ToolCredentialSpec } from "../../../core/src/types";
import { ToolCallControlError } from "../../../core/src/tool-call-control";
import { asPayload } from "../lib/object";

const bearerSecretSchema = z.object({
  token: z.coerce.string().optional(),
});

const apiKeySecretSchema = z.object({
  headerName: z.coerce.string().optional(),
  value: z.coerce.string().optional(),
  token: z.coerce.string().optional(),
});

const basicSecretSchema = z.object({
  username: z.coerce.string().optional(),
  password: z.coerce.string().optional(),
});

const credentialOverrideHeadersSchema = z.object({
  headers: z.record(z.coerce.string()).optional(),
});

export async function resolveCredentialHeaders(
  ctx: ActionCtx,
  spec: ToolCredentialSpec,
  task: TaskRecord,
): Promise<ResolvedToolCredential | null> {
  const record = await ctx.runQuery(internal.database.resolveCredential, {
    workspaceId: task.workspaceId,
    sourceKey: spec.sourceKey,
    scope: spec.mode,
    actorId: task.actorId,
  });

  const source = record
    ? await resolveCredentialPayload(record)
    : spec.staticSecretJson ?? null;
  if (!source) {
    return null;
  }
  const sourcePayload = asPayload(source);

  const headers: Record<string, string> = {};
  if (spec.authType === "bearer") {
    const parsedSecret = bearerSecretSchema.safeParse(sourcePayload);
    const token = parsedSecret.success ? (parsedSecret.data.token ?? "").trim() : "";
    if (token) headers.authorization = `Bearer ${token}`;
  } else if (spec.authType === "apiKey") {
    const parsedSecret = apiKeySecretSchema.safeParse(sourcePayload);
    const headerName = spec.headerName
      ?? (parsedSecret.success ? (parsedSecret.data.headerName ?? "x-api-key") : "x-api-key");
    const value = parsedSecret.success
      ? (parsedSecret.data.value ?? parsedSecret.data.token ?? "").trim()
      : "";
    if (value) headers[headerName] = value;
  } else if (spec.authType === "basic") {
    const parsedSecret = basicSecretSchema.safeParse(sourcePayload);
    const username = parsedSecret.success ? (parsedSecret.data.username ?? "") : "";
    const password = parsedSecret.success ? (parsedSecret.data.password ?? "") : "";
    if (username || password) {
      const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
      headers.authorization = `Basic ${encoded}`;
    }
  }

  const bindingOverrides = credentialOverrideHeadersSchema.safeParse(record?.overridesJson ?? {});
  const overrideHeaders = bindingOverrides.success ? (bindingOverrides.data.headers ?? {}) : {};
  for (const [key, value] of Object.entries(overrideHeaders)) {
    if (!key) continue;
    headers[key] = value;
  }

  if (Object.keys(headers).length === 0) {
    return null;
  }

  return {
    sourceKey: spec.sourceKey,
    mode: spec.mode,
    headers,
  };
}

export function validatePersistedCallRunnable(
  persistedCall: ToolCallRecord,
  callId: string,
): Result<void, Error> {
  if (persistedCall.status === "completed") {
    return Result.err(new Error(`Tool call ${callId} already completed; output is not retained`));
  }

  if (persistedCall.status === "failed") {
    return Result.err(new Error(persistedCall.error ?? `Tool call failed: ${callId}`));
  }

  if (persistedCall.status === "denied") {
    return Result.err(
      new ToolCallControlError({
        kind: "approval_denied",
        reason: persistedCall.error ?? persistedCall.toolPath,
      }),
    );
  }

  return Result.ok(undefined);
}

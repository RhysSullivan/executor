"use node";

import { Result } from "better-result";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { resolveCredentialPayload } from "../../../core/src/credential-providers";
import type { ResolvedToolCredential, TaskRecord, ToolCallRecord, ToolCredentialSpec } from "../../../core/src/types";
import { ToolCallControlError } from "../../../core/src/tool-call-control";
import { asPayload } from "../lib/object";

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
    const token = String(sourcePayload.token ?? "").trim();
    if (token) headers.authorization = `Bearer ${token}`;
  } else if (spec.authType === "apiKey") {
    const headerName = spec.headerName ?? String(sourcePayload.headerName ?? "x-api-key");
    const value = String(sourcePayload.value ?? sourcePayload.token ?? "").trim();
    if (value) headers[headerName] = value;
  } else if (spec.authType === "basic") {
    const username = String(sourcePayload.username ?? "");
    const password = String(sourcePayload.password ?? "");
    if (username || password) {
      const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
      headers.authorization = `Basic ${encoded}`;
    }
  }

  const bindingOverrides = asPayload(record?.overridesJson ?? {});
  const overrideHeaders = asPayload(bindingOverrides.headers);
  for (const [key, value] of Object.entries(overrideHeaders)) {
    if (!key) continue;
    headers[key] = String(value);
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

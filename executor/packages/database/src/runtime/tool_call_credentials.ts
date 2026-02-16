"use node";

import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { resolveCredentialPayload } from "../../../core/src/credential-providers";
import { APPROVAL_DENIED_PREFIX } from "../../../core/src/execution-constants";
import type { CredentialScope, ResolvedToolCredential, TaskRecord, ToolCallRecord, ToolCredentialSpec } from "../../../core/src/types";
import { asPayload } from "../lib/object";

export async function resolveCredentialHeaders(
  ctx: ActionCtx,
  spec: ToolCredentialSpec,
  task: TaskRecord,
): Promise<ResolvedToolCredential | null> {
  const record = await ctx.runQuery(internal.database.resolveCredential, {
    workspaceId: task.workspaceId,
    sourceKey: spec.sourceKey,
    scope: spec.mode as CredentialScope,
    actorId: task.actorId,
  });

  const source = record
    ? await resolveCredentialPayload(record)
    : spec.staticSecretJson ?? null;
  if (!source) {
    return null;
  }

  const headers: Record<string, string> = {};
  if (spec.authType === "bearer") {
    const token = String((source as Record<string, unknown>).token ?? "").trim();
    if (token) headers.authorization = `Bearer ${token}`;
  } else if (spec.authType === "apiKey") {
    const headerName = spec.headerName ?? String((source as Record<string, unknown>).headerName ?? "x-api-key");
    const value = String((source as Record<string, unknown>).value ?? (source as Record<string, unknown>).token ?? "").trim();
    if (value) headers[headerName] = value;
  } else if (spec.authType === "basic") {
    const username = String((source as Record<string, unknown>).username ?? "");
    const password = String((source as Record<string, unknown>).password ?? "");
    if (username || password) {
      const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
      headers.authorization = `Basic ${encoded}`;
    }
  }

  const bindingOverrides = asPayload((record?.overridesJson as unknown) ?? {});
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

export function assertPersistedCallRunnable(persistedCall: ToolCallRecord, callId: string): void {
  if (persistedCall.status === "completed") {
    throw new Error(`Tool call ${callId} already completed; output is not retained`);
  }

  if (persistedCall.status === "failed") {
    throw new Error(persistedCall.error ?? `Tool call failed: ${callId}`);
  }

  if (persistedCall.status === "denied") {
    throw new Error(`${APPROVAL_DENIED_PREFIX}${persistedCall.error ?? persistedCall.toolPath}`);
  }
}
